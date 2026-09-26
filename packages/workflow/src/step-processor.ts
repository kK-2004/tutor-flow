/**
 * 幂等步骤处理器中间件。
 *
 * 所有步骤任务都必须经过这里再进入业务处理器：
 * - 已完成步骤的重投 → 补做未完成的检查点推进，不重复执行业务处理器；
 * - 首次投递 → 写入 RUNNING → 执行业务处理器 → 写入终态与事件；
 * - 失败必须携带错误分类，是否重试由工作流引擎（3.2）决定。
 */
import type { ErrorCategory, StepType } from '@tutor-flow/domain';
import { appendWorkflowEvent, requireRun, NotFoundError } from '@tutor-flow/db';
import type { DbClient } from '@tutor-flow/db';
import { and, desc, eq } from 'drizzle-orm';
import type { Job } from 'bullmq';

import { stepRuns, workflowRuns } from '@tutor-flow/db';
import { createMetrics, type MetricsRegistry } from '@tutor-flow/observability';
import type { StepJobData } from './job-data.js';

/** 步骤尝试行类型 */
export type StepAttemptRow = typeof stepRuns.$inferSelect;
/** 运行任务行类型 */
export type WorkflowRunRow = typeof workflowRuns.$inferSelect;

/** 步骤处理器上下文 */
export interface StepHandlerContext {
  data: StepJobData;
  /** 当前运行任务行（已加载） */
  run: WorkflowRunRow;
  /** 当前步骤尝试行（已确保存在且标记 RUNNING） */
  attempt: StepAttemptRow;
}

/** 处理器成功返回值 */
export interface StepHandlerOutput {
  /** 输出引用（对象键或记录 id），写入 step_run.output_ref */
  outputRef?: string;
}

/** 业务处理器：只做本步骤的工作，重试与状态机交给引擎 */
export type StepHandler = (ctx: StepHandlerContext) => Promise<StepHandlerOutput>;

/** 已分类的业务失败：中间件据此写 FAILED 而不是抛出 */
export class StepFailure extends Error {
  readonly category: ErrorCategory;

  constructor(category: ErrorCategory, message: string) {
    super(message);
    this.name = 'StepFailure';
    this.category = category;
  }
}

export interface StepProcessorOptions {
  db: DbClient;
  /** 可选的进程级指标注册表 */
  metrics?: MetricsRegistry;
  /** 已注册的步骤处理器集合 */
  handlers: Partial<Record<StepType, StepHandler>>;
  /** 步骤成功后的引擎钩子（检查点推进） */
  onStepSuccess?: (context: {
    run: WorkflowRunRow;
    data: StepJobData;
    attempt: StepAttemptRow;
  }) => Promise<void>;
  /** 步骤失败后的引擎钩子（重试/转人工处置） */
  onStepFailure?: (context: {
    run: WorkflowRunRow;
    data: StepJobData;
    attempt: StepAttemptRow;
    category: ErrorCategory;
    message: string;
  }) => Promise<void>;
}

/** 生成 BullMQ 处理函数：内置幂等与持久化 */
export function createStepProcessor(options: StepProcessorOptions) {
  const metrics = options.metrics ?? createMetrics();
  return async (job: Job<StepJobData>): Promise<void> => {
    const { db } = options;
    const data = job.data;

    // 1. 加载运行任务；不存在视为过期投递（库已被清理等），直接确认
    let run: WorkflowRunRow;
    try {
      run = await requireRun(db.db, data.runId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return;
      }
      throw error;
    }

    // 2. 终态运行的任务直接确认（重启恢复后残留的队列投递）
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.status)) {
      return;
    }

    // 3. 取消检查点：已请求取消的运行不再开始新工作
    if (run.cancelRequested) {
      await cancelFromCheckpoint(db, run, data);
      return;
    }

    // 4. 确保步骤尝试行存在（引擎调度时可能已创建）
    const attempt = await ensureAttempt(db, data);

    // 5. 幂等短路：该尝试已到终态（重复投递）
    if (attempt.status === 'SUCCEEDED') {
      if (
        run.currentStepType === data.stepType &&
        !['WAITING_DIRECTION', 'NEEDS_REVIEW', 'NEEDS_HUMAN'].includes(run.status)
      ) {
        await options.onStepSuccess?.({ run, data, attempt });
      }
      return;
    }
    if (attempt.status === 'CANCELLED') {
      return;
    }
    if (attempt.status === 'FAILED') {
      if (
        run.status === 'QUEUED' ||
        (run.currentStepType === data.stepType &&
          !['RETRY_WAIT', 'NEEDS_HUMAN', 'WAITING_DIRECTION', 'NEEDS_REVIEW'].includes(
            run.status,
          ))
      ) {
        await options.onStepFailure?.({
          run,
          data,
          attempt,
          category: attempt.errorCategory ?? 'INTERNAL',
          message: attempt.errorMessage ?? '步骤执行失败',
        });
      }
      return;
    }

    const handler = options.handlers[data.stepType];
    if (handler === undefined) {
      // 未注册处理器：标记失败转人工，避免静默吞掉
      const running = await markRunning(db, attempt);
      if (running === null) {
        return;
      }
      await failAttempt(db, run, running, {
        category: 'INTERNAL',
        message: `步骤 ${data.stepType} 未注册处理器`,
      });
      return;
    }

    // 6. 标记 RUNNING（状态谓词防并发双跑）
    const running = await markRunning(db, attempt);
    if (running === null) {
      // 并发投递：另一消费者已接管该尝试
      return;
    }

    // 7. 执行业务处理器并接引擎钩子
    const startedAt = Date.now();
    metrics.increment('workflow_step_attempts_total');
    let output: StepHandlerOutput;
    try {
      output = await handler({ data, run, attempt: running });
    } catch (error) {
      const classified = classify(error);
      await failAttempt(db, run, running, classified);
      await options.onStepFailure?.({
        run,
        data,
        attempt: running,
        category: classified.category,
        message: classified.message,
      });
      metrics.increment('workflow_step_failure_total');
      metrics.observe('workflow_step_duration_ms', Date.now() - startedAt);
      return;
    }
    await succeedAttempt(db, run, running, output.outputRef);
    // 步骤已成功时，推进失败必须交给队列重投，不能改写为业务失败。
    await options.onStepSuccess?.({ run, data, attempt: running });
    metrics.increment('workflow_step_success_total');
    metrics.observe('workflow_step_duration_ms', Date.now() - startedAt);
  };
}

/** 取消检查点：把运行与未开始的尝试终态化为 CANCELLED */
async function cancelFromCheckpoint(
  db: DbClient,
  run: WorkflowRunRow,
  data: StepJobData,
): Promise<void> {
  const { appendWorkflowEvent } = await import('@tutor-flow/db');
  const executingStates: readonly string[] = [
    'QUEUED',
    'RESEARCHING',
    'GENERATING',
    'MODERATING',
    'READY_TO_PUBLISH',
    'RETRY_WAIT',
  ];
  if (!executingStates.includes(run.status)) {
    return;
  }
  // 未开始的尝试标记为取消
  await db.db
    .update(stepRuns)
    .set({ status: 'CANCELLED', finishedAt: new Date() })
    .where(
      and(
        eq(stepRuns.runId, run.id),
        eq(stepRuns.stepType, data.stepType),
        eq(stepRuns.attemptNo, data.attemptNo),
        eq(stepRuns.status, 'PENDING'),
      ),
    );
  const [updated] = await db.db
    .update(workflowRuns)
    .set({ status: 'CANCELLED', updatedAt: new Date() })
    .where(and(eq(workflowRuns.id, run.id), eq(workflowRuns.version, run.version)))
    .returning();
  if (updated === undefined) {
    return; // 并发修改：留给下一次检查点
  }
  await appendWorkflowEvent(db.db, run.id, 'run.cancelled', {
    requestedBy: run.cancelRequestedBy ?? 'system:checkpoint',
  });
}

/** 标记尝试为 RUNNING；状态谓词不命中返回 null（并发双跑保护） */
async function markRunning(
  db: DbClient,
  attempt: StepAttemptRow,
): Promise<StepAttemptRow | null> {
  const started = await db.db
    .update(stepRuns)
    .set({ status: 'RUNNING', startedAt: new Date() })
    .where(and(eq(stepRuns.id, attempt.id), eq(stepRuns.status, attempt.status)))
    .returning();
  const row = started[0];
  return row ?? null;
}

/** 确保步骤尝试行存在；不存在时创建 */
async function ensureAttempt(db: DbClient, data: StepJobData): Promise<StepAttemptRow> {
  const existing = await db.db
    .select()
    .from(stepRuns)
    .where(and(eq(stepRuns.runId, data.runId), eq(stepRuns.stepType, data.stepType)))
    .orderBy(desc(stepRuns.attemptNo))
    .limit(1);
  const found = existing[0];
  if (found !== undefined && found.attemptNo === data.attemptNo) {
    return found;
  }
  const inserted = await db.db
    .insert(stepRuns)
    .values({
      runId: data.runId,
      stepType: data.stepType,
      attemptNo: data.attemptNo,
      status: 'PENDING',
    })
    .onConflictDoNothing()
    .returning();
  const row = inserted[0];
  if (row !== undefined) {
    return row;
  }
  // 并发创建冲突：重读（唯一索引 run+step+attemptNo）
  const reread = await db.db
    .select()
    .from(stepRuns)
    .where(
      and(
        eq(stepRuns.runId, data.runId),
        eq(stepRuns.stepType, data.stepType),
        eq(stepRuns.attemptNo, data.attemptNo),
      ),
    )
    .limit(1);
  const rereadRow = reread[0];
  if (rereadRow === undefined) {
    throw new Error(`步骤尝试行缺失：run=${data.runId} step=${data.stepType}`);
  }
  return rereadRow;
}

/** 写入成功终态并追加事件 */
async function succeedAttempt(
  db: DbClient,
  run: WorkflowRunRow,
  attempt: StepAttemptRow,
  outputRef?: string,
): Promise<void> {
  await db.db.transaction(async (tx) => {
    await tx
      .update(stepRuns)
      .set({ status: 'SUCCEEDED', outputRef, finishedAt: new Date() })
      .where(and(eq(stepRuns.id, attempt.id), eq(stepRuns.status, 'RUNNING')));
    await appendWorkflowEvent(tx, run.id, 'step.completed', {
      stepRunId: attempt.id,
      stepType: attempt.stepType,
      attempt: attempt.attemptNo,
      outputRef,
    });
  });
}

/** 写入失败终态、错误分类与事件（重试与转人工由引擎 3.2 决策） */
async function failAttempt(
  db: DbClient,
  run: WorkflowRunRow,
  attempt: StepAttemptRow,
  classified: { category: ErrorCategory; message: string },
): Promise<void> {
  await db.db
    .update(stepRuns)
    .set({
      status: 'FAILED',
      errorCategory: classified.category,
      errorMessage: classified.message.slice(0, 500),
      finishedAt: new Date(),
    })
    .where(and(eq(stepRuns.id, attempt.id), eq(stepRuns.status, 'RUNNING')));
  await appendWorkflowEvent(db.db, run.id, 'step.failed', {
    stepRunId: attempt.id,
    stepType: attempt.stepType,
    attempt: attempt.attemptNo,
    category: classified.category,
    message: classified.message.slice(0, 300),
  });
}

/** 将任意错误归一为分类错误 */
function classify(error: unknown): { category: ErrorCategory; message: string } {
  if (error instanceof StepFailure) {
    return { category: error.category, message: error.message };
  }
  return {
    category: 'INTERNAL',
    message: error instanceof Error ? error.message.slice(0, 300) : '未知错误',
  };
}
