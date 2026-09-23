/**
 * 工作流运行任务的状态机定义。
 *
 * 状态与转换表是唯一事实来源；API 与 Worker 只能通过
 * canTransition / assertTransition 改变状态，禁止散落的状态判断。
 */

/** 工作流运行状态全集（数据库枚举与代码共用此数组） */
export const RUN_STATUSES = [
  'QUEUED',
  'RESEARCHING',
  'WAITING_DIRECTION',
  'GENERATING',
  'MODERATING',
  'NEEDS_REVIEW',
  'READY_TO_PUBLISH',
  'PUBLISHING',
  'RETRY_WAIT',
  'NEEDS_HUMAN',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const;

/** 工作流运行状态 */
export type WorkflowRunStatus = (typeof RUN_STATUSES)[number];

/** 终态：进入后不再发生任何状态变化 */
export const TERMINAL_RUN_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const;

/** 终态类型 */
export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

/** 等待人工动作的停点状态 */
export const HUMAN_WAIT_RUN_STATUSES = [
  'WAITING_DIRECTION',
  'NEEDS_REVIEW',
  'NEEDS_HUMAN',
] as const;

/** 人工停点状态类型 */
export type HumanWaitRunStatus = (typeof HUMAN_WAIT_RUN_STATUSES)[number];

/**
 * 状态转换表。
 *
 * 约定：
 * - PUBLISHING 期间不允许取消（外部副作用进行中，必须等安全检查点）；
 * - RETRY_WAIT 恢复到重试步骤所属的阶段；
 * - NEEDS_HUMAN 人工解决后恢复到对应阶段或转入 FAILED/CANCELLED。
 */
const RUN_TRANSITIONS: Record<WorkflowRunStatus, readonly WorkflowRunStatus[]> = {
  QUEUED: ['RESEARCHING', 'CANCELLED', 'FAILED'],
  RESEARCHING: [
    'WAITING_DIRECTION',
    'GENERATING',
    'RETRY_WAIT',
    'NEEDS_HUMAN',
    'FAILED',
    'CANCELLED',
  ],
  WAITING_DIRECTION: ['GENERATING', 'NEEDS_HUMAN', 'CANCELLED'],
  GENERATING: [
    'MODERATING',
    'NEEDS_REVIEW',
    'READY_TO_PUBLISH',
    'RETRY_WAIT',
    'NEEDS_HUMAN',
    'FAILED',
    'CANCELLED',
  ],
  MODERATING: [
    'NEEDS_REVIEW',
    'READY_TO_PUBLISH',
    'RETRY_WAIT',
    'NEEDS_HUMAN',
    'FAILED',
    'CANCELLED',
  ],
  NEEDS_REVIEW: ['READY_TO_PUBLISH', 'NEEDS_HUMAN', 'CANCELLED'],
  READY_TO_PUBLISH: ['PUBLISHING', 'CANCELLED'],
  PUBLISHING: ['SUCCEEDED', 'RETRY_WAIT', 'NEEDS_HUMAN', 'FAILED'],
  RETRY_WAIT: [
    'RESEARCHING',
    'GENERATING',
    'MODERATING',
    'PUBLISHING',
    'NEEDS_HUMAN',
    'FAILED',
    'CANCELLED',
  ],
  NEEDS_HUMAN: [
    'RESEARCHING',
    'GENERATING',
    'MODERATING',
    'PUBLISHING',
    'NEEDS_REVIEW',
    'FAILED',
    'CANCELLED',
  ],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
};

/** 判断状态转换是否合法 */
export function canTransition(from: WorkflowRunStatus, to: WorkflowRunStatus): boolean {
  if (from === to) {
    return false;
  }
  return RUN_TRANSITIONS[from].includes(to);
}

/** 状态转换守卫：非法转换直接抛错（fail-fast，避免脏状态落库） */
export function assertTransition(from: WorkflowRunStatus, to: WorkflowRunStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`非法的工作流状态转换：${from} → ${to}`);
  }
}

/** 是否为终态 */
export function isTerminalRunStatus(status: WorkflowRunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly WorkflowRunStatus[]).includes(status);
}

/** 是否正在等待人工动作 */
export function isHumanWaitStatus(status: WorkflowRunStatus): boolean {
  return (HUMAN_WAIT_RUN_STATUSES as readonly WorkflowRunStatus[]).includes(status);
}

/** 方向决策模式：自动选向或人工选向 */
export const DIRECTION_MODES = ['auto', 'manual'] as const;
export type DirectionMode = (typeof DIRECTION_MODES)[number];

/** 发布审核模式：进草稿箱人工审核，或满足门槛时自动发布 */
export const PUBLISH_MODES = ['review', 'auto'] as const;
export type PublishMode = (typeof PUBLISH_MODES)[number];

/** 触发来源 */
export const TRIGGER_TYPES = ['manual', 'scheduler'] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

/** 运行任务触发信息（调度键与期望执行时间由外部调度器拥有） */
export interface RunTrigger {
  type: TriggerType;
  /** 操作主体：运营人员标识或调度器身份 */
  triggeredBy: string;
  /** 调度器提供的计划键，用于审计关联 */
  schedulerKey?: string;
  /** 期望执行时间（ISO 8601），仅审计用 */
  expectedRunAt?: string;
}
