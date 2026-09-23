/**
 * 平台账号仓储：列表、查询、健康状态更新。
 *
 * 约定：任何查询结果不得将 secretRef 之外的凭据带出
 * （本表只存 secret_ref，天然脱敏；API 层负责从响应中剔除引用）。
 */
import { and, asc, eq } from 'drizzle-orm';

import type { DbExecutor } from '../lib/tx.js';
import { platformAccounts } from '../schema/index.js';

type AccountRow = typeof platformAccounts.$inferSelect;

/** 对外账号视图：永远不返回密钥引用和任何凭据材料。 */
export interface SafeAccountView {
  id: string;
  alias: string;
  platform: string;
  authType: string;
  health: AccountRow['health'];
  lastAuthCheckAt: Date | null;
  lastAuthCheckNote: string | null;
  autoPublishAllowed: boolean;
  concurrency: number;
  tokensPerWindow: number;
  windowMs: number;
  needsHumanAttention: boolean;
  secretConfigured: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** 将数据库账号转换为客户端安全视图。 */
export function toSafeAccountView(account: AccountRow): SafeAccountView {
  return {
    id: account.id,
    alias: account.alias,
    platform: account.platform,
    authType: account.authType,
    health: account.health,
    lastAuthCheckAt: account.lastAuthCheckAt,
    lastAuthCheckNote: account.lastAuthCheckNote,
    autoPublishAllowed: account.autoPublishAllowed,
    concurrency: account.concurrency,
    tokensPerWindow: account.tokensPerWindow,
    windowMs: account.windowMs,
    needsHumanAttention: account.needsHumanAttention,
    secretConfigured: account.secretRef.length > 0,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

/** 账号列表（按别名排序） */
export async function listAccounts(
  db: DbExecutor,
  platform?: 'xiaohongshu',
): Promise<AccountRow[]> {
  return db
    .select()
    .from(platformAccounts)
    .where(platform !== undefined ? eq(platformAccounts.platform, platform) : undefined)
    .orderBy(asc(platformAccounts.alias));
}

/** 按 id 加载账号；不存在抛错由调用方处理（返回 null） */
export async function findAccount(
  db: DbExecutor,
  accountId: string,
): Promise<AccountRow | null> {
  const rows = await db
    .select()
    .from(platformAccounts)
    .where(eq(platformAccounts.id, accountId))
    .limit(1);
  return rows[0] ?? null;
}

/** 创建账号（别名唯一） */
export async function createAccount(
  db: DbExecutor,
  input: { alias: string; secretRef: string; platform?: 'xiaohongshu' },
): Promise<AccountRow> {
  const inserted = await db
    .insert(platformAccounts)
    .values({
      alias: input.alias,
      platform: input.platform ?? 'xiaohongshu',
      secretRef: input.secretRef,
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) {
    throw new Error('账号创建失败');
  }
  return row;
}

/** 更新授权健康状态（检查时间与脱敏说明） */
export async function updateAccountHealth(
  db: DbExecutor,
  accountId: string,
  input: {
    health: AccountRow['health'];
    note?: string;
    /** 是否进入人工处理状态 */
    needsHumanAttention?: boolean;
  },
): Promise<AccountRow> {
  const [updated] = await db
    .update(platformAccounts)
    .set({
      health: input.health,
      lastAuthCheckAt: new Date(),
      lastAuthCheckNote: input.note?.slice(0, 300),
      needsHumanAttention: input.needsHumanAttention ?? input.health !== 'HEALTHY',
      updatedAt: new Date(),
    })
    .where(eq(platformAccounts.id, accountId))
    .returning();
  const row = updated;
  if (row === undefined) {
    throw new Error(`账号不存在：${accountId}`);
  }
  return row;
}

/** 更新账号自动发布策略 */
export async function updateAccountAutoPublish(
  db: DbExecutor,
  accountId: string,
  autoPublishAllowed: boolean,
): Promise<AccountRow> {
  const [updated] = await db
    .update(platformAccounts)
    .set({ autoPublishAllowed, updatedAt: new Date() })
    .where(and(eq(platformAccounts.id, accountId)))
    .returning();
  const row = updated;
  if (row === undefined) {
    throw new Error(`账号不存在：${accountId}`);
  }
  return row;
}

/** 更新账号级并发和令牌桶限制，所有数值都在仓储边界再次校验。 */
export async function updateAccountPublishingLimits(
  db: DbExecutor,
  accountId: string,
  input: { concurrency: number; tokensPerWindow: number; windowMs: number },
): Promise<AccountRow> {
  if (
    !Number.isInteger(input.concurrency) ||
    input.concurrency < 1 ||
    input.concurrency > 4 ||
    !Number.isInteger(input.tokensPerWindow) ||
    input.tokensPerWindow < 1 ||
    input.tokensPerWindow > 100 ||
    !Number.isInteger(input.windowMs) ||
    input.windowMs < 10_000 ||
    input.windowMs > 86_400_000
  ) {
    throw new Error('账号发布限流参数超出允许范围');
  }
  const [updated] = await db
    .update(platformAccounts)
    .set({
      concurrency: input.concurrency,
      tokensPerWindow: input.tokensPerWindow,
      windowMs: input.windowMs,
      updatedAt: new Date(),
    })
    .where(eq(platformAccounts.id, accountId))
    .returning();
  if (updated === undefined) {
    throw new Error(`账号不存在：${accountId}`);
  }
  return updated;
}

/** 人工处理完成后恢复账号健康状态并关闭人工标记。 */
export async function clearAccountHumanAttention(
  db: DbExecutor,
  accountId: string,
  health: AccountRow['health'] = 'HEALTHY',
): Promise<AccountRow> {
  const [updated] = await db
    .update(platformAccounts)
    .set({
      health,
      needsHumanAttention: false,
      lastAuthCheckAt: new Date(),
      lastAuthCheckNote: null,
      updatedAt: new Date(),
    })
    .where(eq(platformAccounts.id, accountId))
    .returning();
  if (updated === undefined) {
    throw new Error(`账号不存在：${accountId}`);
  }
  return updated;
}
