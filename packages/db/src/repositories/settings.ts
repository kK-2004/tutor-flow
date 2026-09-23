/**
 * 系统设置与审计仓储。
 *
 * - 设置：仅非敏感键值，乐观版本更新；
 * - 审计：只追加，动作主体必填（insert-only，数据库层阻止更新/删除）。
 */
import { and, desc, eq } from 'drizzle-orm';

import { OptimisticLockError } from '../lib/errors.js';
import { redactDeep } from '../lib/redact.js';
import type { DbExecutor } from '../lib/tx.js';
import { auditEvents, systemSettings } from '../schema/index.js';

type SystemSettingRow = typeof systemSettings.$inferSelect;
type AuditEventRow = typeof auditEvents.$inferSelect;

/** 读取设置（不存在返回 null） */
export async function getSetting(
  db: DbExecutor,
  key: string,
): Promise<SystemSettingRow | null> {
  const rows = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, key))
    .limit(1);
  return rows[0] ?? null;
}

/** 读取全部设置（管理台设置页用） */
export async function listSettings(db: DbExecutor): Promise<SystemSettingRow[]> {
  return db.select().from(systemSettings).orderBy(desc(systemSettings.key));
}

/** 写入或更新设置：expectedVersion 提供时执行乐观校验 */
export async function upsertSetting(
  db: DbExecutor,
  input: { key: string; value: unknown; updatedBy: string; expectedVersion?: number },
): Promise<SystemSettingRow> {
  if (input.expectedVersion === undefined) {
    const [row] = await db
      .insert(systemSettings)
      .values({
        key: input.key,
        value: input.value as object,
        updatedBy: input.updatedBy,
      })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: {
          value: input.value as object,
          updatedBy: input.updatedBy,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (row === undefined) {
      throw new Error('设置写入失败');
    }
    return row;
  }

  // 乐观更新：key + 版本谓词不命中即冲突
  const [updated] = await db
    .update(systemSettings)
    .set({
      value: input.value as object,
      updatedBy: input.updatedBy,
      version: input.expectedVersion + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(systemSettings.key, input.key),
        eq(systemSettings.version, input.expectedVersion),
      ),
    )
    .returning();
  if (updated === undefined) {
    throw new OptimisticLockError();
  }
  return updated;
}

/** 追加审计事件（载荷自动脱敏；动作主体必填） */
export async function appendAuditEvent(
  db: DbExecutor,
  input: {
    actorType: 'operator' | 'scheduler' | 'system' | 'worker';
    actorId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    runId?: string;
    publishJobId?: string;
    payload?: unknown;
    traceId?: string;
  },
): Promise<AuditEventRow> {
  const inserted = await db
    .insert(auditEvents)
    .values({
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      runId: input.runId,
      publishJobId: input.publishJobId,
      payload:
        input.payload !== undefined ? (redactDeep(input.payload) as object) : undefined,
      traceId: input.traceId,
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) {
    throw new Error('审计事件写入失败');
  }
  return row;
}
