/**
 * BullMQ 队列工厂：基于 @tutor-flow/workflow 的队列契约创建真实队列。
 */
import {
  WORKFLOW_QUEUE,
  type PublishJobData,
  type StepJobData,
} from '@tutor-flow/workflow';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

/** 队列名：小红书发布 */
export const PUBLISH_QUEUE = 'publishing' as const;

export { WORKFLOW_QUEUE };
export type { StepJobData };

/** 发布任务载荷（转发导出，供发布任务 6.x 使用） */
export type { PublishJobData, OutboxJobRoute } from '@tutor-flow/workflow';

/**
 * 创建 BullMQ 共享连接。
 * maxRetriesPerRequest: null 是 BullMQ 的官方要求（任务等待不设上限）。
 */
export function createConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}

/** 队列注册表：延迟创建，进程退出时统一关闭 */
export interface QueueRegistry {
  workflow: Queue<StepJobData>;
  publishing: Queue<PublishJobData>;
  close(): Promise<void>;
}

export function createQueues(connection: Redis): QueueRegistry {
  const workflow = new Queue<StepJobData>(WORKFLOW_QUEUE, {
    connection,
    defaultJobOptions: {
      // 重试策略由数据库工作流引擎拥有；BullMQ 只投递一次
      attempts: 1,
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 3600 },
    },
  });
  const publishing = new Queue<PublishJobData>(PUBLISH_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 3600 },
    },
  });
  return {
    workflow,
    publishing,
    async close(): Promise<void> {
      await workflow.close();
      await publishing.close();
    },
  };
}
