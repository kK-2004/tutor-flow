/**
 * 错误分类体系。
 *
 * 分类决定处置方式：只有明确的瞬时错误允许自动重试；
 * 认证、验证、策略、内容、选择器与未知结果一律转人工，
 * 严禁在结果不明时自动重复外部副作用（见设计文档技术决策 8）。
 */

/** 工作流与发布共用的错误分类全集（数据库枚举共用） */
export const ERROR_CATEGORIES = [
  /** 瞬时错误：网络超时、临时不可用等，确认无副作用后可安全重试 */
  'TRANSIENT',
  /** 限流（429）：有界指数退避后重试 */
  'RATE_LIMITED',
  /** 授权失效：Cookie 过期、会话无效 */
  'AUTH_EXPIRED',
  /** 需要交互式验证：扫码、验证码、短信、异常登录确认 */
  'CHALLENGE_REQUIRED',
  /** 请求校验失败：输入不合法 */
  'VALIDATION',
  /** 平台策略校验失败 */
  'POLICY',
  /** 内容不合规：事实无来源、敏感内容、缺失标识等 */
  'CONTENT',
  /** 页面选择器或页面契约失效 */
  'SELECTOR',
  /** 外部调用结果未知：可能已发生副作用但未获得明确响应 */
  'UNKNOWN_OUTCOME',
  /** 未分类内部错误 */
  'INTERNAL',
] as const;

/** 工作流与发布共用的错误分类 */
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/** 允许自动重试的分类（有界次数 + 退避 + 抖动） */
const RETRYABLE_CATEGORIES: readonly ErrorCategory[] = ['TRANSIENT', 'RATE_LIMITED'];

/** 必须转人工处理的分类 */
const HUMAN_REQUIRED_CATEGORIES: readonly ErrorCategory[] = [
  'AUTH_EXPIRED',
  'CHALLENGE_REQUIRED',
  'VALIDATION',
  'POLICY',
  'CONTENT',
  'SELECTOR',
  'UNKNOWN_OUTCOME',
  'INTERNAL',
];

/** 是否允许自动重试 */
export function isRetryableErrorCategory(category: ErrorCategory): boolean {
  return RETRYABLE_CATEGORIES.includes(category);
}

/** 是否必须人工处理 */
export function requiresHuman(category: ErrorCategory): boolean {
  return HUMAN_REQUIRED_CATEGORIES.includes(category);
}

/** 结构化错误：错误信息必须携带分类，处理逻辑不允许依赖字符串匹配 */
export interface ClassifiedError {
  category: ErrorCategory;
  /** 面向运营人员的中文说明（不含敏感信息） */
  message: string;
  /** 是否已经发生了外部副作用（发布调用已发出等） */
  sideEffectSuspected: boolean;
  /** 可选的补充上下文（已脱敏） */
  context?: Record<string, string>;
}
