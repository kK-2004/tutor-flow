/**
 * 默认配置初始化（仅非敏感项）。
 *
 * 幂等：已存在的设置不覆盖（运营人员修改优先）；
 * 平台策略插入默认版本并标记生效。
 */
import {
  DEFAULT_QUALITY_THRESHOLDS,
  DEFAULT_CONTENT_CENTER_SETTINGS,
  DEFAULT_SEARCH_BUDGET,
  DEFAULT_XIAOHONGSHU_POLICY,
  parseXiaohongshuPolicy,
} from '@tutor-flow/domain';
import { eq, and } from 'drizzle-orm';

import type { DbExecutor } from './lib/tx.js';
import { getSetting, upsertSetting } from './repositories/settings.js';
import { createAdminUser, hashAdminPassword } from './repositories/admin-auth.js';
import { adminUsers, platformAccounts, platformPolicies } from './schema/index.js';

/** 单账号部署默认绑定的小红书平台账号 ID。 */
export const DEFAULT_XHS_ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';

/** 首期强制人工审核发布的默认开关（小红书走浏览器自动化，保守起步） */
export const DEFAULT_PUBLISH_GUARDS = {
  /** 是否强制人工批准（true 时 auto 模式也必须经草稿箱） */
  requireHumanApproval: true,
  /** 默认审核模式 */
  defaultReviewMode: 'review',
} as const;

/** 初始化全部非敏感默认配置（幂等，可重复执行） */
export async function seedDefaultSettings(
  db: DbExecutor,
  actor = 'system:seed',
  bootstrap?: { username: string; password: string },
): Promise<void> {
  await db
    .insert(platformAccounts)
    .values({
      id: DEFAULT_XHS_ACCOUNT_ID,
      alias: '小红书账号',
      platform: 'xiaohongshu',
      secretRef: 'sidecar:xiaohongshu-mcp',
    })
    .onConflictDoNothing();

  if (bootstrap !== undefined) {
    const existingSuperAdmins = await db
      .select({ id: adminUsers.id })
      .from(adminUsers)
      .where(eq(adminUsers.role, 'SUPER_ADMIN'))
      .limit(1);
    if (existingSuperAdmins.length === 0) {
      await createAdminUser(db, {
        username: bootstrap.username,
        passwordHash: await hashAdminPassword(bootstrap.password),
        role: 'SUPER_ADMIN',
        createdBy: actor,
      });
    }
  }

  // 质量门槛
  if ((await getSetting(db, 'quality_thresholds')) === null) {
    await upsertSetting(db, {
      key: 'quality_thresholds',
      value: DEFAULT_QUALITY_THRESHOLDS,
      updatedBy: actor,
    });
  }

  // 搜索预算
  if ((await getSetting(db, 'search_budget')) === null) {
    await upsertSetting(db, {
      key: 'search_budget',
      value: DEFAULT_SEARCH_BUDGET,
      updatedBy: actor,
    });
  }

  // 内容中心仅保存非敏感参数，连接地址和应用令牌由服务端配置提供。
  if ((await getSetting(db, 'content_center')) === null) {
    await upsertSetting(db, {
      key: 'content_center',
      value: DEFAULT_CONTENT_CENTER_SETTINGS,
      updatedBy: actor,
    });
  }

  // 模型别名只保存非敏感标识，不保存供应商密钥。
  if ((await getSetting(db, 'model_aliases')) === null) {
    await upsertSetting(db, {
      key: 'model_aliases',
      value: {
        queryPlanning: 'research-default',
        canonicalArticle: 'content-default',
        direction: 'direction-default',
      },
      updatedBy: actor,
    });
  }

  // 发布安全开关（强制人工审核）
  if ((await getSetting(db, 'publish_guards')) === null) {
    await upsertSetting(db, {
      key: 'publish_guards',
      value: DEFAULT_PUBLISH_GUARDS,
      updatedBy: actor,
    });
  }

  // 版本化小红书策略：不存在任何版本时插入默认版本并标记生效
  const existingPolicy = await db
    .select({ id: platformPolicies.id })
    .from(platformPolicies)
    .where(
      and(
        eq(platformPolicies.platform, 'xiaohongshu'),
        eq(platformPolicies.version, DEFAULT_XIAOHONGSHU_POLICY.policyVersion),
      ),
    )
    .limit(1);
  if (existingPolicy.length === 0) {
    await db
      .insert(platformPolicies)
      .values({
        platform: 'xiaohongshu',
        version: DEFAULT_XIAOHONGSHU_POLICY.policyVersion,
        policy: DEFAULT_XIAOHONGSHU_POLICY,
        isActive: true,
        createdBy: actor,
      })
      .onConflictDoNothing();
  }
}

/** 读取当前生效的平台策略（无记录时回退默认策略） */
export async function getActivePlatformPolicy(db: DbExecutor): Promise<{
  version: string;
  policy: typeof DEFAULT_XIAOHONGSHU_POLICY;
  persisted: boolean;
}> {
  const rows = await db
    .select({ version: platformPolicies.version, policy: platformPolicies.policy })
    .from(platformPolicies)
    .where(
      and(
        eq(platformPolicies.platform, 'xiaohongshu'),
        eq(platformPolicies.isActive, true),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return {
      version: DEFAULT_XIAOHONGSHU_POLICY.policyVersion,
      policy: DEFAULT_XIAOHONGSHU_POLICY,
      persisted: false,
    };
  }
  return {
    version: row.version,
    policy: parseXiaohongshuPolicy(row.policy),
    persisted: true,
  };
}
