/**
 * 工作流事件仓储：持久化追加与按 id 重放（SSE Last-Event-ID 支持）。
 */
import { and, asc, eq, gt, sql } from 'drizzle-orm';

import { PG_UNIQUE_VIOLATION } from '../lib/errors.js';
import { redactDeep } from '../lib/redact.js';
import type { DbExecutor } from '../lib/tx.js';
import { workflowEvents } from '../schema/index.js';

type WorkflowEventRow = typeof workflowEvents.$inferSelect;

/** 追加事件：seq 取运行内最大值 +1；唯一索引冲突时短重试 */
export async function appendWorkflowEvent(
  db: DbExecutor,
  runId: string,
  name: string,
  payload: unknown,
): Promise<WorkflowEventRow> {
  const redacted = redactDeep(payload);
  for (let attempt = 0; attempt < 3; attempt++) {
    const rows = await db
      .select({ maxSeq: sql<number>`coalesce(max(${workflowEvents.seq}), 0)` })
      .from(workflowEvents)
      .where(eq(workflowEvents.runId, runId));
    const nextSeq = (rows[0]?.maxSeq ?? 0) + 1;
    try {
      const inserted = await db
        .insert(workflowEvents)
        .values({ runId, seq: nextSeq, name, payload: redacted as object })
        .returning();
      const row = inserted[0];
      if (row !== undefined) {
        return row;
      }
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: string }).code === PG_UNIQUE_VIOLATION &&
        attempt < 2
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new Error(`事件追加失败：${name}`);
}

/** 按 id 重放：返回 id 大于 afterId 的运行事件（按全局 id 升序） */
export async function listEventsAfter(
  db: DbExecutor,
  runId: string,
  afterId?: number,
  limit = 500,
): Promise<WorkflowEventRow[]> {
  const conditions =
    afterId !== undefined
      ? and(eq(workflowEvents.runId, runId), gt(workflowEvents.id, afterId))
      : eq(workflowEvents.runId, runId);
  return db
    .select()
    .from(workflowEvents)
    .where(conditions)
    .orderBy(asc(workflowEvents.id))
    .limit(limit);
}

/** 读取运行内全部事件（详情页用，按 seq 排序） */
export async function listRunEvents(
  db: DbExecutor,
  runId: string,
  limit = 1000,
): Promise<WorkflowEventRow[]> {
  return db
    .select()
    .from(workflowEvents)
    .where(eq(workflowEvents.runId, runId))
    .orderBy(asc(workflowEvents.seq))
    .limit(limit);
}
