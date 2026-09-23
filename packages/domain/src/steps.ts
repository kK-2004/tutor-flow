/**
 * 工作流步骤定义。
 *
 * 每次执行都落在具体步骤上，step_run 记录输入摘要、输出引用、
 * 尝试次数、错误分类与 trace id（见设计文档技术决策 3）。
 */

/** 工作流步骤类型全集（按生产链路顺序，数据库枚举共用） */
export const STEP_TYPES = [
  // 研究阶段
  'QUERY_PLANNING',
  'SEARCH',
  'FETCH_SOURCES',
  'DEDUPE_SOURCES',
  'SCORE_SOURCES',
  'EXTRACT_CLAIMS',
  // 方向决策
  'GENERATE_DIRECTIONS',
  'SELECT_DIRECTION',
  // 内容生成
  'GENERATE_CANONICAL',
  'ADAPT_XIAOHONGSHU',
  // 审核与草稿
  'MODERATE_CONTENT',
  'CREATE_DRAFT',
  // 发布
  'VALIDATE_PUBLISH',
  'PUBLISH',
  'VERIFY_PUBLICATION',
] as const;

/** 工作流步骤类型 */
export type StepType = (typeof STEP_TYPES)[number];

/** 步骤尝试状态 */
export const STEP_ATTEMPT_STATUSES = [
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'SKIPPED',
] as const;

/** 步骤尝试状态类型 */
export type StepAttemptStatus = (typeof STEP_ATTEMPT_STATUSES)[number];

/** 已终态的步骤尝试 */
export const TERMINAL_STEP_ATTEMPT_STATUSES = [
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'SKIPPED',
] as const;

/** 步骤是否允许人工重试（错误分类由 errors.ts 提供最终判定） */
export const RETRYABLE_STEP_TYPES: readonly StepType[] = [
  'SEARCH',
  'FETCH_SOURCES',
  'DEDUPE_SOURCES',
  'SCORE_SOURCES',
  'EXTRACT_CLAIMS',
  'GENERATE_DIRECTIONS',
  'GENERATE_CANONICAL',
  'ADAPT_XIAOHONGSHU',
  'MODERATE_CONTENT',
  'PUBLISH',
  'VERIFY_PUBLICATION',
];

/** 判断步骤是否属于可重试类型（SELECT_DIRECTION 等决策步骤不可“重试”，只能重新决策） */
export function isRetryableStepType(stepType: StepType): boolean {
  return RETRYABLE_STEP_TYPES.includes(stepType);
}
