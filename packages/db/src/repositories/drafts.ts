/**
 * 草稿仓储：修订链创建、乐观修订保存、事务性幂等批准。
 *
 * 修订模型：每次保存插入新 revision 行；并发保存以最新修订号判定冲突。
 * 批准：单事务内重校验最新修订并创建发布任务，唯一约束保证最多一个。
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { DraftMedia } from '@tutor-flow/domain';

import { appendWorkflowEvent } from './events.js';
import { getRunWithJob, transitionRunStatus } from './runs.js';
import { NotFoundError, RevisionConflictError, StateGuardError } from '../lib/errors.js';
import type { Db, DbExecutor, DbTx } from '../lib/tx.js';
import {
  claims,
  claimSources,
  contentJobs,
  draftRevisions,
  outboxRecords,
  publishJobs,
  workflowRuns,
} from '../schema/index.js';

/** 草稿列表项（最新修订 + 所属任务主题） */
export async function listDrafts(
  db: DbExecutor,
  options: { status?: string; limit?: number; offset?: number },
): Promise<{
  items: Array<{
    draft: typeof draftRevisions.$inferSelect;
    job: typeof contentJobs.$inferSelect;
  }>;
  total: number;
}> {
  const status = options.status ?? 'PENDING_REVIEW';
  // 取该状态全部修订，JS 侧保留每个运行的最新修订（低量级首期足够）
  const rows = await db
    .select({ draft: draftRevisions, job: contentJobs })
    .from(draftRevisions)
    .innerJoin(workflowRuns, eq(draftRevisions.runId, workflowRuns.id))
    .innerJoin(contentJobs, eq(workflowRuns.contentJobId, contentJobs.id))
    .where(
      and(
        eq(draftRevisions.status, status as never),
        isNull(draftRevisions.deletedAt),
        isNull(workflowRuns.deletedAt),
      ),
    )
    .orderBy(desc(draftRevisions.updatedAt));
  const latestByRun = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const existing = latestByRun.get(row.draft.runId);
    if (existing === undefined || row.draft.revision > existing.draft.revision) {
      latestByRun.set(row.draft.runId, row);
    }
  }
  const all = [...latestByRun.values()].sort(
    (a, b) => b.draft.updatedAt.getTime() - a.draft.updatedAt.getTime(),
  );
  const start = options.offset ?? 0;
  return {
    items: all.slice(start, start + (options.limit ?? 50)),
    total: all.length,
  };
}

/** 运行内事实的来源支持情况（无来源事实门槛依据） */
export async function loadRunClaimSupport(
  db: DbExecutor,
  runId: string,
): Promise<Array<{ claimId: string; statement: string; hasSource: boolean }>> {
  const rows = await db.select().from(claims).where(eq(claims.runId, runId));
  const links = await db.select({ claimId: claimSources.claimId }).from(claimSources);
  const linked = new Set(links.map((link) => link.claimId));
  return rows.map((row) => ({
    claimId: row.id,
    statement: row.statement,
    hasSource: linked.has(row.id),
  }));
}

type DraftRevisionRow = typeof draftRevisions.$inferSelect;
type PublishJobRow = typeof publishJobs.$inferSelect;

/** 创建首版草稿修订 */
export async function createDraftRevision(
  db: DbExecutor,
  input: {
    runId: string;
    title: string;
    body: string;
    tags: string[];
    mediaObjectKeys: DraftMedia[];
    sourceArtifactId?: string;
    claimUsages: Array<{ claimId: string; locator: string }>;
    createdBy: string;
    aigcDisclosure?: string;
  },
): Promise<DraftRevisionRow> {
  const inserted = await db
    .insert(draftRevisions)
    .values({
      runId: input.runId,
      revision: 1,
      title: input.title,
      body: input.body,
      tags: input.tags,
      mediaObjectKeys: input.mediaObjectKeys,
      sourceArtifactId: input.sourceArtifactId,
      claimUsages: input.claimUsages,
      createdBy: input.createdBy,
      aigcDisclosure: input.aigcDisclosure ?? 'disclosed',
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) {
    throw new Error('草稿修订创建失败');
  }
  return row;
}

/** 读取运行当前草稿（最新修订） */
export async function getLatestDraftRevision(
  db: DbExecutor,
  runId: string,
): Promise<DraftRevisionRow | null> {
  const [run] = await db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(and(eq(workflowRuns.id, runId), isNull(workflowRuns.deletedAt)))
    .limit(1);
  if (run === undefined) {
    return null;
  }
  const rows = await db
    .select()
    .from(draftRevisions)
    .where(and(eq(draftRevisions.runId, runId), isNull(draftRevisions.deletedAt)))
    .orderBy(desc(draftRevisions.revision))
    .limit(1);
  return rows[0] ?? null;
}

/** 将草稿修订链从草稿箱移除；待审核工作流随之取消，历史记录继续保留。 */
export async function softDeleteDraftRevisions(
  db: Db,
  runId: string,
): Promise<{ revision: number; status: string }> {
  return db.transaction(async (tx) => {
    const run = await getRunWithJob(tx, runId);
    if (run === null) {
      throw new NotFoundError(`运行任务不存在：${runId}`);
    }
    const latest = await getLatestDraftRevision(tx, runId);
    if (latest === null) {
      throw new NotFoundError(`草稿不存在：run=${runId}`);
    }
    if (
      ![
        'WAITING_DIRECTION',
        'NEEDS_REVIEW',
        'NEEDS_HUMAN',
        'SUCCEEDED',
        'FAILED',
        'CANCELLED',
      ].includes(run.run.status)
    ) {
      throw new StateGuardError('关联工作流正在执行或发布，暂时不能删除草稿');
    }
    if (run.run.status === 'NEEDS_REVIEW') {
      await transitionRunStatus(tx, runId, 'CANCELLED', {
        expectedVersion: run.run.version,
      });
    }
    const now = new Date();
    await tx
      .update(draftRevisions)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(draftRevisions.runId, runId), isNull(draftRevisions.deletedAt)));
    await appendWorkflowEvent(tx, runId, 'draft.deleted', { revision: latest.revision });
    return { revision: latest.revision, status: latest.status };
  });
}

/** 保存新修订：expectedRevision 不等于最新修订号时抛修订冲突 */
export async function saveDraftRevision(
  db: Db,
  input: {
    runId: string;
    expectedRevision: number;
    title?: string;
    body?: string;
    tags?: string[];
    mediaObjectKeys?: DraftMedia[];
    aigcDisclosure?: string;
    savedBy: string;
    /** 本次保存中被移除内容的清洗说明 */
    sanitizationNotes?: string[];
  },
): Promise<DraftRevisionRow> {
  return db.transaction(async (tx) => {
    const latest = await requireLatest(tx, input.runId);
    if (latest.revision !== input.expectedRevision) {
      throw new RevisionConflictError(latest.revision);
    }
    if (latest.status !== 'PENDING_REVIEW') {
      throw new StateGuardError(`草稿当前状态为 ${latest.status}，不允许编辑`);
    }
    const inserted = await tx
      .insert(draftRevisions)
      .values({
        runId: input.runId,
        revision: latest.revision + 1,
        status: 'PENDING_REVIEW',
        title: input.title ?? latest.title,
        body: input.body ?? latest.body,
        tags: input.tags ?? latest.tags,
        mediaObjectKeys: input.mediaObjectKeys ?? latest.mediaObjectKeys,
        sourceArtifactId: latest.sourceArtifactId,
        claimUsages: latest.claimUsages,
        aigcDisclosure: input.aigcDisclosure ?? latest.aigcDisclosure,
        createdBy: input.savedBy,
        sanitizationNotes:
          input.sanitizationNotes !== undefined
            ? { removed: input.sanitizationNotes }
            : undefined,
      })
      .returning();
    const row = inserted[0];
    if (row === undefined) {
      throw new Error('草稿修订保存失败');
    }
    return row;
  });
}

/**
 * 事务性批准：校验最新修订并创建发布任务。
 *
 * 幂等：同一修订重复批准返回既有发布任务（publish_job 唯一约束兜底）；
 * 冲突：最新修订号与预期不符时抛修订冲突，不产生任何副作用。
 */
export async function approveDraft(
  db: Db,
  input: {
    runId: string;
    expectedRevision: number;
    approvedBy: string;
    /** 发布幂等键（由调用方按稳定规则计算） */
    publishIdempotencyKey: string;
    accountId: string;
    /** 批准时生效的策略版本（快照） */
    policyVersion: string;
  },
): Promise<{ draft: DraftRevisionRow; publishJob: PublishJobRow; created: boolean }> {
  return db.transaction(async (tx) => {
    const latest = await requireLatest(tx, input.runId);
    if (latest.revision !== input.expectedRevision) {
      throw new RevisionConflictError(latest.revision);
    }

    // 重复批准短路：该修订已有发布任务则直接返回
    const existingJobs = await tx
      .select()
      .from(publishJobs)
      .where(eq(publishJobs.draftRevisionId, latest.id))
      .limit(1);
    const existingJob = existingJobs[0];
    if (existingJob !== undefined) {
      return { draft: latest, publishJob: existingJob, created: false };
    }

    if (latest.status !== 'PENDING_REVIEW') {
      throw new StateGuardError(`草稿当前状态为 ${latest.status}，不允许批准`);
    }

    const approved = await tx
      .update(draftRevisions)
      .set({
        status: 'APPROVED',
        approvedBy: input.approvedBy,
        approvedAt: new Date(),
        approvedPolicyVersion: input.policyVersion,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(draftRevisions.id, latest.id),
          eq(draftRevisions.revision, input.expectedRevision),
        ),
      )
      .returning();
    const approvedRow = approved[0];
    if (approvedRow === undefined) {
      throw new RevisionConflictError(latest.revision);
    }

    const createdJobs = await tx
      .insert(publishJobs)
      .values({
        runId: input.runId,
        draftRevisionId: latest.id,
        accountId: input.accountId,
        idempotencyKey: input.publishIdempotencyKey,
        approvedBy: input.approvedBy,
      })
      .onConflictDoNothing({ target: publishJobs.idempotencyKey })
      .returning();
    const job = createdJobs[0];
    if (job === undefined) {
      // 极小概率的并发批准：回滚批准动作并交由调用方重试读取
      throw new StateGuardError('发布任务创建冲突，请重试');
    }
    // 批准与发布入队同事务写入发件箱，避免数据库成功但队列遗漏。
    await tx.insert(outboxRecords).values({
      eventName: 'publish.queued',
      aggregateType: 'publish_job',
      aggregateId: job.id,
      payload: {
        job: {
          queue: 'publishing',
          name: 'publish-job',
          data: {
            publishJobId: job.id,
            accountId: job.accountId,
            idempotencyKey: job.idempotencyKey,
          },
        },
      },
    });
    return { draft: approvedRow, publishJob: job, created: true };
  });
}

/** 内容模式批准：原子完成草稿与运行，不创建任何发布任务。 */
export async function approveContentDraft(
  db: Db,
  input: { runId: string; expectedRevision: number; approvedBy: string },
) {
  return db.transaction(async (tx) => {
    const latest = await requireLatest(tx, input.runId);
    if (latest.revision !== input.expectedRevision)
      throw new RevisionConflictError(latest.revision);
    if (latest.status === 'APPROVED') return latest;
    if (latest.status !== 'PENDING_REVIEW')
      throw new StateGuardError('仅待审核草稿可以批准');
    const run = (
      await tx.select().from(workflowRuns).where(eq(workflowRuns.id, input.runId))
    )[0];
    if (run?.status !== 'NEEDS_REVIEW')
      throw new StateGuardError('任务当前不在草稿审核阶段');
    const [draft] = await tx
      .update(draftRevisions)
      .set({
        status: 'APPROVED',
        approvedBy: input.approvedBy,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(draftRevisions.id, latest.id))
      .returning();
    await tx
      .update(workflowRuns)
      .set({ status: 'SUCCEEDED', updatedAt: new Date() })
      .where(eq(workflowRuns.id, input.runId));
    await appendWorkflowEvent(tx, input.runId, 'draft.approved', {
      revision: latest.revision,
    });
    return draft!;
  });
}

/** 加载最新修订；不存在时抛 NotFoundError */
async function requireLatest(tx: DbTx, runId: string): Promise<DraftRevisionRow> {
  const latest = await getLatestDraftRevision(tx, runId);
  if (latest === null) {
    throw new NotFoundError(`草稿不存在：run=${runId}`);
  }
  return latest;
}
