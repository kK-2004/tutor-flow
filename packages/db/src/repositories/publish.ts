/**
 * 发布仓储：稳定幂等键、咨询锁、回执优先落库。
 */
import { createHash } from 'node:crypto';

import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { advisoryXactLock } from '../lib/advisory-lock.js';
import { NotFoundError } from '../lib/errors.js';
import { redactDeep } from '../lib/redact.js';
import type { DbExecutor } from '../lib/tx.js';
import {
  draftRevisions,
  platformAccounts,
  publishJobs,
  publishReceipts,
} from '../schema/index.js';

type PublishJobRow = typeof publishJobs.$inferSelect;
type PublishReceiptRow = typeof publishReceipts.$inferSelect;

/** 发布幂等键的工作空间命名空间（首期单工作空间） */
const PUBLISH_WORKSPACE = 'tutor-flow-default';

/**
 * 计算稳定发布幂等键：工作空间 + 平台账号 + 内容制品版本 + 发布槽位。
 * 同键重复投递在数据库层面被唯一约束与回执短路拦下。
 */
export function computePublishIdempotencyKey(input: {
  accountId: string;
  artifactVersion: number;
  /** 发布槽位：同内容重复发布的第几次机会（首次为 1） */
  slot?: number;
}): string {
  const slot = input.slot ?? 1;
  const raw = `${PUBLISH_WORKSPACE}:${input.accountId}:${input.artifactVersion}:${slot}`;
  return createHash('sha256').update(raw).digest('hex');
}

/** 发布锁键：与幂等键同源（同前缀哈希），保证同任务互斥 */
export function computePublishLockKey(idempotencyKey: string): string {
  return `publish:${idempotencyKey}`;
}

/** 在事务内获取发布咨询锁（事务提交时自动释放） */
export async function acquirePublishLock(
  tx: DbExecutor,
  idempotencyKey: string,
): Promise<void> {
  await advisoryXactLock(tx, computePublishLockKey(idempotencyKey));
}

/** 按幂等键查找发布任务（回执优先短路路径的第一步） */
export async function findPublishJobByKey(
  db: DbExecutor,
  idempotencyKey: string,
): Promise<PublishJobRow | null> {
  const rows = await db
    .select()
    .from(publishJobs)
    .where(eq(publishJobs.idempotencyKey, idempotencyKey))
    .limit(1);
  return rows[0] ?? null;
}

/** 按加载发布任务 */
export async function requirePublishJob(
  db: DbExecutor,
  publishJobId: string,
): Promise<PublishJobRow> {
  const rows = await db
    .select()
    .from(publishJobs)
    .where(eq(publishJobs.id, publishJobId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new NotFoundError(`发布任务不存在：${publishJobId}`);
  }
  return row;
}

/**
 * 原子认领发布任务。
 *
 * SQLite 的写事务提供单写者互斥；用状态谓词认领后，重复投递只能读取
 * PUBLISHING 状态而不能再次进入外部副作用阶段。
 */
export async function claimPublishJob(
  db: DbExecutor,
  publishJobId: string,
): Promise<PublishJobRow | null> {
  const [claimed] = await db
    .update(publishJobs)
    .set({
      status: 'PUBLISHING',
      attempts: sql`${publishJobs.attempts} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(publishJobs.id, publishJobId),
        inArray(publishJobs.status, ['QUEUED', 'FAILED']),
      ),
    )
    .returning();
  return claimed ?? null;
}

/**
 * 回执优先落库：先写回执再标记任务成功。
 * 重复写入（同任务已有回执）返回既有回执，不产生第二份平台凭证记录。
 */
export async function upsertPublishReceipt(
  db: DbExecutor,
  input: {
    publishJobId: string;
    platformPostId: string;
    platformUrl?: string;
    requestHash: string;
    sanitizedResponse: Record<string, unknown>;
    publishedAt: Date;
    policyVersion: string;
  },
): Promise<{ receipt: PublishReceiptRow; created: boolean }> {
  const existing = await db
    .select()
    .from(publishReceipts)
    .where(eq(publishReceipts.publishJobId, input.publishJobId))
    .limit(1);
  const existingReceipt = existing[0];
  if (existingReceipt !== undefined) {
    return { receipt: existingReceipt, created: false };
  }
  const inserted = await db
    .insert(publishReceipts)
    .values({
      publishJobId: input.publishJobId,
      platformPostId: input.platformPostId,
      platformUrl: input.platformUrl,
      requestHash: input.requestHash,
      sanitizedResponse: redactDeep(input.sanitizedResponse) as object,
      publishedAt: input.publishedAt,
      policyVersion: input.policyVersion,
    })
    .onConflictDoNothing({ target: publishReceipts.publishJobId })
    .returning();
  const row = inserted[0];
  if (row === undefined) {
    const raced = await db
      .select()
      .from(publishReceipts)
      .where(eq(publishReceipts.publishJobId, input.publishJobId))
      .limit(1);
    const racedRow = raced[0];
    if (racedRow === undefined) {
      throw new Error('回执写入失败');
    }
    return { receipt: racedRow, created: false };
  }
  return { receipt: row, created: true };
}

/** 更新任务状态（调用方必须已持有该任务的发布锁；SQLite 单写者写事务即互斥） */
export async function updatePublishJobStatus(
  db: DbExecutor,
  publishJobId: string,
  status: PublishJobRow['status'],
  patch: {
    lastError?: { category: string; message: string };
    attempts?: number;
    /** 显式清理上一次错误，供人工重试恢复队列状态。 */
    clearError?: boolean;
  } = {},
): Promise<PublishJobRow> {
  const [updated] = await db
    .update(publishJobs)
    .set({
      status,
      ...(patch.clearError === true || patch.lastError !== undefined
        ? { lastError: patch.clearError === true ? null : patch.lastError }
        : {}),
      ...(patch.attempts !== undefined ? { attempts: patch.attempts } : {}),
      updatedAt: new Date(),
    })
    .where(eq(publishJobs.id, publishJobId))
    .returning();
  if (updated === undefined) {
    throw new NotFoundError(`发布任务不存在或状态不可更新：${publishJobId}`);
  }
  return updated;
}

/** 按运行查询发布任务（取最新创建的一条；状态可选） */
export async function getRunPublishJob(
  db: DbExecutor,
  runId: string,
  statuses?: readonly PublishJobRow['status'][],
): Promise<PublishJobRow | null> {
  const rows = await db
    .select()
    .from(publishJobs)
    .where(
      statuses !== undefined
        ? and(eq(publishJobs.runId, runId), inArray(publishJobs.status, [...statuses]))
        : eq(publishJobs.runId, runId),
    )
    .orderBy(desc(publishJobs.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** 发布队列列表，客户端只得到账号别名和脱敏回执。 */
export async function listPublishJobs(
  db: DbExecutor,
  options: {
    status?: PublishJobRow['status'];
    limit?: number;
    offset?: number;
  } = {},
): Promise<{
  items: Array<{
    job: PublishJobRow;
    account: typeof platformAccounts.$inferSelect;
    draft: typeof draftRevisions.$inferSelect;
    receipt: PublishReceiptRow | null;
  }>;
  total: number;
}> {
  const where =
    options.status !== undefined ? eq(publishJobs.status, options.status) : undefined;
  const rows = await db
    .select({ job: publishJobs, account: platformAccounts, draft: draftRevisions })
    .from(publishJobs)
    .innerJoin(platformAccounts, eq(publishJobs.accountId, platformAccounts.id))
    .innerJoin(draftRevisions, eq(publishJobs.draftRevisionId, draftRevisions.id))
    .where(where)
    .orderBy(desc(publishJobs.updatedAt));
  const start = options.offset ?? 0;
  const page = rows.slice(start, start + (options.limit ?? 50));
  const items = await Promise.all(
    page.map(async (row) => ({
      ...row,
      receipt: await findReceiptByJob(db, row.job.id),
    })),
  );
  return { items, total: rows.length };
}

/** 按 id 查询发布任务及脱敏关联数据。 */
export async function getPublishJobDetails(
  db: DbExecutor,
  publishJobId: string,
): Promise<{
  job: PublishJobRow;
  account: typeof platformAccounts.$inferSelect;
  draft: typeof draftRevisions.$inferSelect;
  receipt: PublishReceiptRow | null;
} | null> {
  const rows = await db
    .select({ job: publishJobs, account: platformAccounts, draft: draftRevisions })
    .from(publishJobs)
    .innerJoin(platformAccounts, eq(publishJobs.accountId, platformAccounts.id))
    .innerJoin(draftRevisions, eq(publishJobs.draftRevisionId, draftRevisions.id))
    .where(eq(publishJobs.id, publishJobId))
    .limit(1);
  const row = rows[0];
  return row === undefined
    ? null
    : { ...row, receipt: await findReceiptByJob(db, publishJobId) };
}

/** 更新回执核验状态（核验流程结果落库） */
export async function updateReceiptVerification(
  db: DbExecutor,
  publishJobId: string,
  verification: PublishReceiptRow['verification'],
  platformUrl?: string,
  note?: string,
): Promise<void> {
  await db
    .update(publishReceipts)
    .set({
      verification,
      verificationNote: note?.slice(0, 300),
      ...(platformUrl !== undefined ? { platformUrl } : {}),
      verifiedAt: new Date(),
    })
    .where(eq(publishReceipts.publishJobId, publishJobId));
}

/** 查询任务的回执（可能不存在） */
export async function findReceiptByJob(
  db: DbExecutor,
  publishJobId: string,
): Promise<PublishReceiptRow | null> {
  const rows = await db
    .select()
    .from(publishReceipts)
    .where(eq(publishReceipts.publishJobId, publishJobId))
    .limit(1);
  return rows[0] ?? null;
}
