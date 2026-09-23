/**
 * 发布域领域类型。
 *
 * 发布采用 effectively-once 策略：advisory lock + 稳定幂等键 +
 * 回执优先落库；未知结果必须先核验再处置。
 */

import type { ErrorCategory } from './errors.js';
import type { Platform } from './platform.js';

/** 发布任务状态全集（数据库枚举共用） */
export const PUBLISH_JOB_STATUSES = [
  'QUEUED',
  'PUBLISHING',
  'SUCCEEDED',
  'FAILED',
  /** 外部结果未知：必须先 queryStatus 核验 */
  'UNKNOWN_OUTCOME',
  /** 人工处理：授权、验证、策略、内容或选择器问题 */
  'NEEDS_HUMAN',
  'CANCELLED',
] as const;

/** 发布任务状态 */
export type PublishJobStatus = (typeof PUBLISH_JOB_STATUSES)[number];

/** 发布任务终态 */
export const TERMINAL_PUBLISH_JOB_STATUSES = ['SUCCEEDED', 'CANCELLED'] as const;

/** 回执核验状态全集（数据库枚举共用） */
export const RECEIPT_VERIFICATION_STATUSES = [
  'PENDING',
  'VERIFIED',
  'MISSING',
  'REJECTED',
] as const;

/** 回执核验状态 */
export type ReceiptVerificationStatus = (typeof RECEIPT_VERIFICATION_STATUSES)[number];

/** 发布回执（先于任务成功状态落库） */
export interface PublishReceipt {
  id: string;
  publishJobId: string;
  /** 平台内容标识 */
  platformPostId: string;
  /** 平台内容 URL（可用时） */
  platformUrl?: string;
  /** 请求载荷哈希（脱敏） */
  requestHash: string;
  /** 已脱敏响应摘要 */
  sanitizedResponse: Record<string, string | number | boolean | null>;
  publishedAt: string;
  /** 发布时生效的平台策略版本 */
  policyVersion: string;
  verification: ReceiptVerificationStatus;
  verifiedAt?: string;
}

/** 发布任务（业务视图） */
export interface PublishJob {
  id: string;
  runId: string;
  draftId: string;
  /** 发布内容制品版本 */
  artifactVersion: number;
  platformAccountId: string;
  status: PublishJobStatus;
  /** 稳定幂等键（workspace+账号+制品版本+发布槽位） */
  idempotencyKey: string;
  attempts: number;
  lastError?: {
    category: ErrorCategory;
    message: string;
  };
  receipt?: PublishReceipt;
  createdAt: string;
  updatedAt: string;
}

/** 平台账号授权健康状态全集（数据库枚举共用） */
export const ACCOUNT_HEALTH_STATUSES = [
  'HEALTHY',
  'UNKNOWN',
  'AUTH_REQUIRED',
  'CHALLENGE_REQUIRED',
  'DISABLED',
] as const;

/** 平台账号授权健康状态 */
export type AccountHealthStatus = (typeof ACCOUNT_HEALTH_STATUSES)[number];

/** 最后一次授权检查结果摘要（不含任何密钥材料） */
export interface AccountAuthCheckResult {
  checkedAt: string;
  healthy: AccountHealthStatus;
  /** 需要人工处理时的中文说明 */
  message?: string;
}

/** 小红书平台账号（业务视图；凭据只存 secret_ref） */
export interface PlatformAccount {
  id: string;
  /** 账号别名（展示用） */
  alias: string;
  platform: Platform;
  /** 授权类型：cookie 会话或其他 */
  authType: 'cookie_session';
  /** 密钥引用（例如 env:XHS_ACCOUNT_XXX），不保存明文 */
  secretRef: string;
  health: AccountHealthStatus;
  lastAuthCheckAt?: string;
  /** 账号级发布策略：是否允许自动发布 */
  autoPublishAllowed: boolean;
  /** 账号级并发与限流配置 */
  publishingLimits: {
    concurrency: number;
    /** 令牌桶：窗口内最大发布数 */
    tokensPerWindow: number;
    windowMs: number;
  };
  /** 是否处于人工处理状态 */
  needsHumanAttention: boolean;
  createdAt: string;
}
