/**
 * 队列契约类型：队列名与任务载荷。
 *
 * BullMQ 只承担调度与临时协调，业务状态事实来源始终是 PostgreSQL；
 * 任务载荷可重复投递，消费者必须幂等。
 */
import type { StepType } from '@tutor-flow/domain';

/** 队列名：工作流步骤 */
export const WORKFLOW_QUEUE = 'workflow' as const;

/** 步骤任务载荷 */
export interface StepJobData {
  runId: string;
  stepType: StepType;
  /** 步骤尝试序号（与 step_run.attempt_no 对应） */
  attemptNo: number;
}

/** 发布任务载荷（任务 6.x 使用，先固定契约） */
export interface PublishJobData {
  publishJobId: string;
  accountId: string;
  idempotencyKey: string;
}

/** 发件箱载荷中的自描述路由 */
export interface OutboxJobRoute {
  queue: string;
  name: string;
  data: StepJobData | PublishJobData | Record<string, unknown>;
  /** 延迟投递（毫秒），重试退避使用 */
  delayMs?: number;
}
