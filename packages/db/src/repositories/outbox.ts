/**
 * 发件箱仓储：事务内写入、批量读取、分发标记。
 *
 * 业务事务提交后才能读取待分发记录；队列投递在事务外进行。
 * 崩溃时记录保持未分发，至少一次投递，发件箱任务 ID 和消费端负责幂等。
 */
import { and, asc, inArray, isNull, lt, notLike, sql } from 'drizzle-orm';

import { redactDeep } from '../lib/redact.js';
import type { DbExecutor } from '../lib/tx.js';
import { outboxRecords } from '../schema/index.js';

type OutboxRow = typeof outboxRecords.$inferSelect;

/** 事务内追加发件箱记录（载荷自动脱敏） */
export async function enqueueOutbox(
  db: DbExecutor,
  record: {
    eventName: string;
    aggregateType: string;
    aggregateId: string;
    payload: unknown;
  },
): Promise<OutboxRow> {
  const inserted = await db
    .insert(outboxRecords)
    .values({
      eventName: record.eventName,
      aggregateType: record.aggregateType,
      aggregateId: record.aggregateId,
      payload: redactDeep(record.payload) as object,
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) {
    throw new Error('发件箱写入失败');
  }
  return row;
}

/** 读取待分发记录（不持有写锁；多个分发器由队列任务 ID 去重） */
export async function claimPendingOutbox(
  db: DbExecutor,
  options: { limit?: number; maxAttempts?: number },
): Promise<OutboxRow[]> {
  return db
    .select()
    .from(outboxRecords)
    .where(
      and(
        isNull(outboxRecords.dispatchedAt),
        lt(outboxRecords.attempts, options.maxAttempts ?? 20),
        // 历史发布记录留在库中供人工核对，不再投递至已停用的发布队列。
        notLike(outboxRecords.eventName, 'publish.%'),
      ),
    )
    .orderBy(asc(outboxRecords.id))
    .limit(options.limit ?? 50);
}

/** 标记已分发 */
export async function markOutboxDispatched(db: DbExecutor, ids: number[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  await db
    .update(outboxRecords)
    .set({ dispatchedAt: new Date() })
    .where(inArray(outboxRecords.id, ids));
}

/** 记录分发失败（累加尝试次数，超过上限由恢复扫描处理） */
export async function markOutboxFailed(
  db: DbExecutor,
  ids: number[],
  error: string,
): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  await db
    .update(outboxRecords)
    .set({
      attempts: sql`${outboxRecords.attempts} + 1`,
      lastError: error.slice(0, 500),
    })
    .where(inArray(outboxRecords.id, ids));
}
