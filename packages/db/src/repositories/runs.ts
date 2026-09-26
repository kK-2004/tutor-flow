/**
 * 运行任务仓储：创建（含触发幂等）、乐观锁状态转换、查询与取消请求。
 */
import { assertTransition } from '@tutor-flow/domain';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import {
  IdempotencyConflictError,
  NotFoundError,
  OptimisticLockError,
  PG_UNIQUE_VIOLATION,
  StateGuardError,
} from '../lib/errors.js';
import { redactDeep } from '../lib/redact.js';
import type { Db, DbExecutor } from '../lib/tx.js';
import { appendWorkflowEvent } from './events.js';
import {
  contentJobs,
  outboxRecords,
  triggerIdempotencyRecords,
  workflowEvents,
  workflowRuns,
} from '../schema/index.js';

/** 创建运行任务的输入 */
export interface CreateRunInput {
  /** 调用方身份（幂等键的作用域） */
  callerIdentity: string;
  /** 幂等键；外部调度必填，管理台可选 */
  idempotencyKey?: string;
  /** 规范化载荷哈希（幂等冲突检测） */
  requestHash: string;
  topic: string;
  researchMode?: 'search' | 'library' | 'hybrid';
  researchDocumentIds?: string[];
  directionMode: 'auto' | 'manual';
  publishMode: 'review' | 'auto';
  platform: 'xiaohongshu';
  accountId: string;
  triggerType: 'manual' | 'scheduler';
  triggeredBy: string;
  schedulerKey?: string;
  expectedRunAt?: string;
  traceId?: string;
}

/** 创建运行任务的结果 */
export interface CreateRunResult {
  jobId: string;
  runId: string;
  /** true 表示幂等重放：返回原运行而非新建 */
  replayed: boolean;
}

type ContentJob = typeof contentJobs.$inferSelect;
type WorkflowRun = typeof workflowRuns.$inferSelect;

/**
 * 创建内容任务与运行任务（单事务）。
 *
 * 幂等语义：同 (callerIdentity, idempotencyKey) 且载荷一致 → 返回原运行；
 * 载荷不一致 → IdempotencyConflictError。并发插入依赖唯一索引兜底。
 */
export async function createRun(db: Db, input: CreateRunInput): Promise<CreateRunResult> {
  if (input.idempotencyKey !== undefined) {
    const existing = await findByIdempotencyKey(
      db,
      input.callerIdentity,
      input.idempotencyKey,
    );
    if (existing !== null) {
      if (existing.requestHash !== input.requestHash) {
        throw new IdempotencyConflictError();
      }
      return {
        jobId: existing.contentJobId,
        runId: existing.workflowRunId,
        replayed: true,
      };
    }
  }

  try {
    return await withRunInsert(db, input);
  } catch (error) {
    // 并发下同键插入触发唯一约束：转为重放或冲突判定
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === PG_UNIQUE_VIOLATION &&
      input.idempotencyKey !== undefined
    ) {
      const existing = await findByIdempotencyKey(
        db,
        input.callerIdentity,
        input.idempotencyKey,
      );
      if (existing !== null && existing.requestHash === input.requestHash) {
        return {
          jobId: existing.contentJobId,
          runId: existing.workflowRunId,
          replayed: true,
        };
      }
      throw new IdempotencyConflictError();
    }
    throw error;
  }
}

/** 事务内写入：content_job + workflow_run + 幂等记录 + 创建事件 + 发件箱 */
async function withRunInsert(db: Db, input: CreateRunInput): Promise<CreateRunResult> {
  return db.transaction(async (tx) => {
    const [job] = await tx
      .insert(contentJobs)
      .values({
        topic: input.topic,
        researchMode: input.researchMode ?? 'search',
        researchDocumentIds: input.researchDocumentIds ?? [],
        directionMode: input.directionMode,
        publishMode: input.publishMode,
        platform: input.platform,
        accountId: input.accountId,
        triggerType: input.triggerType,
        triggeredBy: input.triggeredBy,
        schedulerKey: input.schedulerKey,
        expectedRunAt:
          input.expectedRunAt !== undefined ? new Date(input.expectedRunAt) : undefined,
      })
      .returning();

    if (job === undefined) {
      throw new Error('内容任务插入失败');
    }

    const [run] = await tx
      .insert(workflowRuns)
      .values({ contentJobId: job.id, traceId: input.traceId })
      .returning();

    if (run === undefined) {
      throw new Error('运行任务插入失败');
    }

    if (input.idempotencyKey !== undefined) {
      await tx.insert(triggerIdempotencyRecords).values({
        callerIdentity: input.callerIdentity,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        contentJobId: job.id,
        workflowRunId: run.id,
      });
    }

    // 运行内首条事件：seq 1（载荷经脱敏）
    await tx.insert(workflowEvents).values({
      runId: run.id,
      seq: 1,
      name: 'run.created',
      payload: redactDeep({
        topicLength: input.topic.length,
        directionMode: input.directionMode,
        publishMode: input.publishMode,
        platform: input.platform,
        triggerType: input.triggerType,
        triggeredBy: input.triggeredBy,
      }),
    });

    // 发件箱：驱动工作流开始执行（分发器在任务 3.1 接手）。
    // 载荷携带自描述的 job 路由信息；QUERY_PLANNING 为工作流首步。
    await tx.insert(outboxRecords).values({
      eventName: 'workflow.start',
      aggregateType: 'workflow_run',
      aggregateId: run.id,
      payload: {
        runId: run.id,
        job: {
          queue: 'workflow',
          name: 'workflow-step',
          data: { runId: run.id, stepType: 'QUERY_PLANNING', attemptNo: 1 },
        },
      },
    });

    return { jobId: job.id, runId: run.id, replayed: false };
  });
}

/** 按幂等键查询触发记录 */
async function findByIdempotencyKey(
  db: DbExecutor,
  callerIdentity: string,
  idempotencyKey: string,
): Promise<{ contentJobId: string; workflowRunId: string; requestHash: string } | null> {
  const rows = await db
    .select({
      contentJobId: triggerIdempotencyRecords.contentJobId,
      workflowRunId: triggerIdempotencyRecords.workflowRunId,
      requestHash: triggerIdempotencyRecords.requestHash,
    })
    .from(triggerIdempotencyRecords)
    .where(
      and(
        eq(triggerIdempotencyRecords.callerIdentity, callerIdentity),
        eq(triggerIdempotencyRecords.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * 乐观锁状态转换。
 *
 * 先读当前版本并校验领域转换合法性，再以版本号谓词更新；
 * 并发修改导致谓词不命中时抛 OptimisticLockError。
 */
export async function transitionRunStatus(
  db: DbExecutor,
  runId: string,
  to: WorkflowRun['status'],
  options: {
    expectedVersion: number;
    currentStepType?: WorkflowRun['currentStepType'];
    humanWaitSince?: Date | null;
  },
): Promise<WorkflowRun> {
  const current = await requireRun(db, runId);

  try {
    assertTransition(current.status, to);
  } catch (error) {
    // 统一转为仓储层状态守卫错误（API 层映射 409/422）
    throw new StateGuardError(error instanceof Error ? error.message : String(error));
  }

  const [updated] = await db
    .update(workflowRuns)
    .set({
      status: to,
      currentStepType: options.currentStepType ?? current.currentStepType,
      humanWaitSince:
        options.humanWaitSince !== undefined
          ? options.humanWaitSince
          : current.humanWaitSince,
      version: current.version + 1,
      updatedAt: new Date(),
    })
    .where(
      and(eq(workflowRuns.id, runId), eq(workflowRuns.version, options.expectedVersion)),
    )
    .returning();

  if (updated === undefined) {
    throw new OptimisticLockError();
  }
  return updated;
}

/** 同一运行阶段内推进当前步骤，并保持乐观锁版本递增。 */
export async function advanceRunStep(
  db: DbExecutor,
  runId: string,
  stepType: NonNullable<WorkflowRun['currentStepType']>,
  expectedVersion: number,
): Promise<void> {
  const [updated] = await db
    .update(workflowRuns)
    .set({
      currentStepType: stepType,
      version: expectedVersion + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.version, expectedVersion)))
    .returning();
  if (updated === undefined) {
    throw new OptimisticLockError();
  }
}

/** 记录选中的候选方向（乐观锁；选向后由内容生成读取） */
export async function setRunSelectedDirection(
  db: DbExecutor,
  runId: string,
  directionId: string,
  expectedVersion: number,
): Promise<void> {
  const [updated] = await db
    .update(workflowRuns)
    .set({
      selectedDirectionId: directionId,
      version: expectedVersion + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.version, expectedVersion)))
    .returning();
  if (updated === undefined) {
    throw new OptimisticLockError();
  }
}

/** 标记取消请求（实际转换由 Worker 在安全检查点执行） */
export async function requestRunCancel(
  db: DbExecutor,
  runId: string,
  requestedBy: string,
): Promise<WorkflowRun> {
  const current = await requireRun(db, runId);
  if (current.cancelRequested) {
    return current;
  }
  const [updated] = await db
    .update(workflowRuns)
    .set({
      cancelRequested: true,
      cancelRequestedAt: new Date(),
      cancelRequestedBy: requestedBy,
      version: current.version + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.version, current.version)))
    .returning();
  if (updated === undefined) {
    throw new OptimisticLockError();
  }
  return updated;
}

/** 按 id 加载运行；不存在时抛 NotFoundError */
export async function requireRun(db: DbExecutor, runId: string): Promise<WorkflowRun> {
  const rows = await db
    .select()
    .from(workflowRuns)
    .where(and(eq(workflowRuns.id, runId), isNull(workflowRuns.deletedAt)))
    .limit(1);
  const run = rows[0];
  if (run === undefined) {
    throw new NotFoundError(`运行任务不存在：${runId}`);
  }
  return run;
}

/** 加载运行及其内容任务（引擎规划需要模式信息） */
export async function getRunWithJob(
  db: DbExecutor,
  runId: string,
): Promise<{ run: WorkflowRun; job: ContentJob } | null> {
  const rows = await db
    .select({ run: workflowRuns, job: contentJobs })
    .from(workflowRuns)
    .innerJoin(contentJobs, eq(workflowRuns.contentJobId, contentJobs.id))
    .where(and(eq(workflowRuns.id, runId), isNull(workflowRuns.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

/** 扫描需要恢复的运行：非终态且未在人工停点的运行 */
export async function listResumableRuns(
  db: DbExecutor,
  limit = 100,
): Promise<WorkflowRun[]> {
  const rows = await db
    .select()
    .from(workflowRuns)
    .where(
      and(
        inArray(workflowRuns.status, [
          'QUEUED',
          'RESEARCHING',
          'GENERATING',
          'MODERATING',
          'RETRY_WAIT',
          'READY_TO_PUBLISH',
        ]),
        isNull(workflowRuns.deletedAt),
      ),
    )
    .limit(limit);
  return rows;
}

/** 运行任务列表（状态筛选 + 分页，按创建时间倒序） */
export async function listRuns(
  db: DbExecutor,
  options: { status?: WorkflowRun['status']; limit?: number; offset?: number },
): Promise<{ items: Array<{ run: WorkflowRun; job: ContentJob }>; total: number }> {
  const where = and(
    options.status !== undefined ? eq(workflowRuns.status, options.status) : undefined,
    isNull(workflowRuns.deletedAt),
  );
  const items = await db
    .select({ run: workflowRuns, job: contentJobs })
    .from(workflowRuns)
    .innerJoin(contentJobs, eq(workflowRuns.contentJobId, contentJobs.id))
    .where(where)
    .orderBy(desc(workflowRuns.createdAt))
    .limit(options.limit ?? 20)
    .offset(options.offset ?? 0);
  const counts = await db
    .select({ count: sql<number>`count(*)` })
    .from(workflowRuns)
    .where(where);
  return { items, total: counts[0]?.count ?? 0 };
}

/** 将非运行中工作流从管理列表中移除，保留历史数据与审计引用。 */
export async function softDeleteWorkflowRun(
  db: Db,
  runId: string,
): Promise<{ status: WorkflowRun['status']; contentJobId: string }> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ run: workflowRuns, contentJobId: contentJobs.id })
      .from(workflowRuns)
      .innerJoin(contentJobs, eq(workflowRuns.contentJobId, contentJobs.id))
      .where(and(eq(workflowRuns.id, runId), isNull(workflowRuns.deletedAt)))
      .limit(1);
    if (current === undefined) {
      throw new NotFoundError(`运行任务不存在：${runId}`);
    }
    if (
      ![
        'WAITING_DIRECTION',
        'NEEDS_REVIEW',
        'NEEDS_HUMAN',
        'SUCCEEDED',
        'FAILED',
        'CANCELLED',
      ].includes(current.run.status)
    ) {
      throw new StateGuardError('正在执行或发布中的工作流不能删除，请等待其停止后再试');
    }
    const [deleted] = await tx
      .update(workflowRuns)
      .set({
        deletedAt: new Date(),
        updatedAt: new Date(),
        version: current.run.version + 1,
      })
      .where(
        and(
          eq(workflowRuns.id, runId),
          eq(workflowRuns.version, current.run.version),
          isNull(workflowRuns.deletedAt),
        ),
      )
      .returning();
    if (deleted === undefined) {
      throw new OptimisticLockError();
    }
    await appendWorkflowEvent(tx, runId, 'run.deleted', {
      previousStatus: current.run.status,
    });
    return { status: current.run.status, contentJobId: current.contentJobId };
  });
}
