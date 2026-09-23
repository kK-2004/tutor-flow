/**
 * 独立发布队列处理器。
 *
 * 发布器只消费 publishing 队列，不与研究和内容步骤共享进程级故障边界。
 * 适配器异常先分类落库；只有确认没有外部副作用的瞬时错误才重新入队。
 */
import {
  appendAuditEvent,
  getPublishJobDetails,
  requireRun,
  updatePublishJobStatus,
  type DbClient,
} from '@tutor-flow/db';
import { PublisherError, type PublisherAdapter } from '@tutor-flow/integrations';
import type { Job, Queue } from 'bullmq';

import { createPublishLanes } from './lanes.js';
import {
  createPublishHandler,
  type PublishingHandlersDeps,
} from '../steps/publishing.js';
import type { PublishJobData } from '../queues.js';
import type { SecretProvider } from '@tutor-flow/config/server';
import {
  createLogger,
  createMetrics,
  type MetricsRegistry,
} from '@tutor-flow/observability';

/** 发布队列处理器依赖。 */
export interface PublishProcessorOptions {
  db: DbClient;
  adapter: PublisherAdapter;
  secrets: SecretProvider;
  queue?: Queue<PublishJobData>;
  jitterMs?: number;
  maxRetries?: number;
  /** 与 Worker 健康端点共享的指标注册表 */
  metrics?: MetricsRegistry;
}

/** 瞬时错误的有界退避，避免外部平台遭遇重试风暴。 */
export function publishRetryDelayMs(attemptNo: number): number {
  const capped = Math.min(Math.max(attemptNo, 1), 3);
  return Math.min(2_000 * 2 ** (capped - 1), 30_000) + Math.floor(Math.random() * 500);
}

/** 创建 BullMQ 发布任务处理函数。 */
export function createPublishJobProcessor(options: PublishProcessorOptions) {
  const metrics = options.metrics ?? createMetrics();
  const lanes = createPublishLanes({ metrics });
  const logger = createLogger({ service: 'publisher-worker' });
  const deps: PublishingHandlersDeps = {
    db: options.db,
    adapter: options.adapter,
    lanes,
    secrets: options.secrets,
    jitterMs: options.jitterMs,
  };
  const publishStep = createPublishHandler(deps);
  const maxRetries = options.maxRetries ?? 3;

  return async (job: Job<PublishJobData>): Promise<void> => {
    const details = await getPublishJobDetails(options.db.db, job.data.publishJobId);
    if (details === null) {
      return;
    }
    const run = await requireRun(options.db.db, details.job.runId);
    try {
      metrics.increment('publisher_attempts_total');
      await publishStep({
        data: { runId: run.id, stepType: 'PUBLISH', attemptNo: details.job.attempts + 1 },
        run,
        attempt: {} as never,
      });
    } catch (error) {
      const publisherError = error instanceof PublisherError ? error : null;
      const category = publisherError?.code ?? 'TRANSIENT';
      const message = publisherError?.message ?? '发布处理器异常';
      const current = await getPublishJobDetails(options.db.db, details.job.id);
      const attemptNo = current?.job.attempts ?? details.job.attempts;

      if (category === 'TRANSIENT' && attemptNo < maxRetries) {
        metrics.increment('publisher_retries_total');
        await updatePublishJobStatus(options.db.db, details.job.id, 'FAILED', {
          lastError: { category: 'TRANSIENT', message },
        });
        await appendAuditEvent(options.db.db, {
          actorType: 'worker',
          actorId: 'publisher-worker',
          action: 'publish.retry_scheduled',
          resourceType: 'publish_job',
          resourceId: details.job.id,
          runId: details.job.runId,
          publishJobId: details.job.id,
          payload: { attempt: attemptNo, category, scheduled: true },
          traceId: run.traceId ?? undefined,
        });
        if (options.queue !== undefined) {
          await options.queue.add('publish-job', job.data, {
            delay: publishRetryDelayMs(attemptNo),
            attempts: 1,
          });
        }
        return;
      }

      if (current?.job.status === 'PUBLISHING') {
        await updatePublishJobStatus(options.db.db, details.job.id, 'NEEDS_HUMAN', {
          lastError: { category, message },
        });
      }
      await appendAuditEvent(options.db.db, {
        actorType: 'worker',
        actorId: 'publisher-worker',
        action: 'publish.failed',
        resourceType: 'publish_job',
        resourceId: details.job.id,
        runId: details.job.runId,
        publishJobId: details.job.id,
        payload: { category, message },
        traceId: run.traceId ?? undefined,
      });
      logger.warn('发布任务转人工处理', {
        publishJobId: details.job.id,
        category,
        runId: details.job.runId,
      });
    }
  };
}
