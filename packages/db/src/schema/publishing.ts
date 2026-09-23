/**
 * 草稿与发布表（SQLite）：草稿修订、平台账号、平台策略、
 * 发布任务、发布回执。
 *
 * 约定：
 * - 账号凭据只保存 secret_ref，任何表不允许出现 Cookie/明文凭据；
 * - publish_job.draft_revision_id 唯一约束保证一个草稿修订最多一个发布任务；
 * - publish_receipt 与 publish_job 一对一，回执先于成功状态落库。
 */
import { randomUUID } from 'node:crypto';

import {
  ACCOUNT_HEALTH_STATUSES,
  DRAFT_STATUSES,
  PUBLISH_JOB_STATUSES,
  RECEIPT_VERIFICATION_STATUSES,
} from '@tutor-flow/domain';
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import { contentArtifacts } from './research.js';
import { workflowRuns } from './workflow.js';

const uuidPk = () =>
  text()
    .primaryKey()
    .$defaultFn(() => randomUUID());

const timestampMs = () => integer({ mode: 'timestamp_ms' });

const now = () =>
  timestampMs()
    .notNull()
    .$defaultFn(() => new Date());

// ---------- 枚举列 ----------

/** 草稿状态列 */
export const draftStatusColumn = () => text({ enum: DRAFT_STATUSES });
/** 发布任务状态列 */
export const publishJobStatusColumn = () => text({ enum: PUBLISH_JOB_STATUSES });
/** 回执核验状态列 */
export const receiptVerificationColumn = () =>
  text({ enum: RECEIPT_VERIFICATION_STATUSES });
/** 账号健康状态列 */
export const accountHealthColumn = () => text({ enum: ACCOUNT_HEALTH_STATUSES });

// ---------- 草稿修订 ----------

/**
 * 草稿修订：小红书制品的可编辑版本序列（乐观并发以 revision 递增）。
 * 服务端清洗富文本后才允许写入。
 */
export const draftRevisions = sqliteTable(
  'draft_revision',
  {
    id: uuidPk(),
    runId: text()
      .notNull()
      .references(() => workflowRuns.id),
    /** 递增修订号（同一运行内从 1 开始） */
    revision: integer().notNull(),
    status: draftStatusColumn().notNull().default('PENDING_REVIEW'),
    title: text().notNull(),
    /** 服务端清洗后的正文（受控 HTML/Markdown） */
    body: text().notNull(),
    tags: text({ mode: 'json' }).notNull(),
    /** 有序媒体引用：普通对象键或内容中心文件元数据，保存在 JSON 列。 */
    mediaObjectKeys: text({ mode: 'json' }).notNull(),
    /** 来源制品引用（小红书稿派生自 CANONICAL 制品版本） */
    sourceArtifactId: text().references(() => contentArtifacts.id),
    /** 事实引用快照：[{ claimId, locator }]（编辑后重新校验） */
    claimUsages: text({ mode: 'json' }).notNull(),
    aigcDisclosure: text().notNull().default('disclosed'),
    /** 批准信息（批准时快照，未批准为空） */
    approvedBy: text(),
    approvedAt: timestampMs(),
    approvedPolicyVersion: text(),
    /** 清洗记录：被移除内容的说明（不含正文） */
    sanitizationNotes: text({ mode: 'json' }),
    createdBy: text().notNull(),
    createdAt: now(),
    updatedAt: now(),
  },
  (t) => [
    uniqueIndex('draft_revision_run_revision_unique').on(t.runId, t.revision),
    index('draft_revision_status_idx').on(t.status),
  ],
);

// ---------- 平台账号 ----------

/** 小红书平台账号：凭据仅存 secret_ref */
export const platformAccounts = sqliteTable(
  'platform_account',
  {
    id: uuidPk(),
    alias: text().notNull(),
    platform: text().notNull().default('xiaohongshu'),
    /** 授权类型（首期仅 cookie 会话） */
    authType: text().notNull().default('cookie_session'),
    /** 密钥引用（如 env:XHS_ACCOUNT_X） */
    secretRef: text().notNull(),
    health: accountHealthColumn().notNull().default('UNKNOWN'),
    lastAuthCheckAt: timestampMs(),
    /** 最近一次检查的脱敏说明 */
    lastAuthCheckNote: text(),
    /** 账号策略：是否允许自动发布（默认 false） */
    autoPublishAllowed: integer({ mode: 'boolean' }).notNull().default(false),
    /** 账号级并发与令牌桶限流 */
    concurrency: integer().notNull().default(1),
    tokensPerWindow: integer().notNull().default(4),
    windowMs: integer().notNull().default(3_600_000),
    needsHumanAttention: integer({ mode: 'boolean' }).notNull().default(false),
    createdAt: now(),
    updatedAt: now(),
  },
  (t) => [uniqueIndex('platform_account_alias_unique').on(t.alias)],
);

// ---------- 平台策略 ----------

/** 版本化小红书平台策略：运行时生效版本由 is_active 标记 */
export const platformPolicies = sqliteTable(
  'platform_policy',
  {
    id: uuidPk(),
    platform: text().notNull().default('xiaohongshu'),
    /** 策略版本标识（如 xhs-policy@2026.09） */
    version: text().notNull(),
    /** 完整策略 JSON（结构见 domain.XiaohongshuPolicy） */
    policy: text({ mode: 'json' }).notNull(),
    isActive: integer({ mode: 'boolean' }).notNull().default(false),
    createdBy: text(),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex('platform_policy_platform_version_unique').on(t.platform, t.version),
    // 每个平台至多一个生效版本（部分唯一索引）
    uniqueIndex('platform_policy_active_unique')
      .on(t.platform)
      .where(sql`is_active`),
  ],
);

// ---------- 发布任务 ----------

/** 发布任务：批准草稿后创建的隔离发布执行单元 */
export const publishJobs = sqliteTable(
  'publish_job',
  {
    id: uuidPk(),
    runId: text()
      .notNull()
      .references(() => workflowRuns.id),
    /** 发布的草稿修订（一个修订最多一个发布任务） */
    draftRevisionId: text()
      .notNull()
      .references(() => draftRevisions.id),
    accountId: text()
      .notNull()
      .references(() => platformAccounts.id),
    status: publishJobStatusColumn().notNull().default('QUEUED'),
    /** 稳定发布幂等键（workspace+账号+制品版本+发布槽位） */
    idempotencyKey: text().notNull(),
    attempts: integer().notNull().default(0),
    /** 最近错误：{ category, message }（已脱敏） */
    lastError: text({ mode: 'json' }),
    /** 审批人（来源于草稿批准动作） */
    approvedBy: text(),
    createdAt: now(),
    updatedAt: now(),
  },
  (t) => [
    uniqueIndex('publish_job_draft_revision_unique').on(t.draftRevisionId),
    uniqueIndex('publish_job_idempotency_key_unique').on(t.idempotencyKey),
    index('publish_job_status_idx').on(t.status),
  ],
);

// ---------- 发布回执 ----------

/** 发布回执：平台返回的唯一凭证，先于任务成功状态落库 */
export const publishReceipts = sqliteTable(
  'publish_receipt',
  {
    id: uuidPk(),
    publishJobId: text()
      .notNull()
      .references(() => publishJobs.id),
    platformPostId: text().notNull(),
    platformUrl: text(),
    /** 请求载荷哈希（脱敏） */
    requestHash: text().notNull(),
    /** 已脱敏平台响应摘要 */
    sanitizedResponse: text({ mode: 'json' }).notNull(),
    publishedAt: timestampMs().notNull(),
    /** 发布时生效的策略版本 */
    policyVersion: text().notNull(),
    verification: receiptVerificationColumn().notNull().default('PENDING'),
    verificationNote: text(),
    verifiedAt: timestampMs(),
    createdAt: now(),
  },
  (t) => [uniqueIndex('publish_receipt_job_unique').on(t.publishJobId)],
);
