/**
 * 事务性发件箱分发器。
 *
 * 读取已提交记录，事务外投递到 BullMQ，再标记结果，避免等待 Redis 时占用写锁。
 * 崩溃窗口采用至少一次投递；发件箱 ID 去重与消费端幂等共同保护重投。
 */
import {
  claimPendingOutbox,
  markOutboxDispatched,
  markOutboxFailed,
} from '@tutor-flow/db';
import type { OutboxJobRoute } from '@tutor-flow/workflow';

import type { QueueRegistry } from './queues.js';
import type { DbClient } from '@tutor-flow/db';

export interface DispatcherOptions {
  /** 轮询间隔（毫秒） */
  intervalMs?: number;
  /** 单批认领上限 */
  batchSize?: number;
  /** 未分发记录的最大尝试次数（超过则留待恢复扫描处理） */
  maxAttempts?: number;
}

export class OutboxDispatcher {
  private readonly db: DbClient;
  private readonly queues: QueueRegistry;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private inFlight: Promise<number> | null = null;

  constructor(db: DbClient, queues: QueueRegistry, options: DispatcherOptions = {}) {
    this.db = db;
    this.queues = queues;
    this.intervalMs = options.intervalMs ?? 500;
    this.batchSize = options.batchSize ?? 50;
    this.maxAttempts = options.maxAttempts ?? 20;
  }

  start(): void {
    if (this.stopped) {
      throw new Error('分发器已停止，不允许重启');
    }
    this.running = true;
    const tick = async (): Promise<void> => {
      if (!this.running) {
        return;
      }
      try {
        await this.dispatchOnce();
      } catch (error) {
        // 分发失败不终止进程：记录后进入下一轮
        console.error('发件箱分发异常：', error instanceof Error ? error.message : error);
      }
      if (this.running) {
        this.timer = setTimeout(() => {
          void tick();
        }, this.intervalMs);
      }
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // 分发异常由轮询记录，停止时仍需继续关闭队列与数据库。
    await this.inFlight?.catch(() => undefined);
  }

  /** 单轮分发：认领 → 投递 → 标记 */
  dispatchOnce(): Promise<number> {
    this.inFlight ??= this.dispatchBatch().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async dispatchBatch(): Promise<number> {
    const tx = this.db.db;
    const rows = await claimPendingOutbox(tx, {
      limit: this.batchSize,
      maxAttempts: this.maxAttempts,
    });
    if (rows.length === 0) {
      return 0;
    }
    const dispatched: number[] = [];
    const failed: number[] = [];
    for (const row of rows) {
      const route = extractRoute(row.payload);
      if (route === null) {
        // 无路由信息的记录视为已完成使命（防御性处理）
        dispatched.push(row.id);
        continue;
      }
      try {
        await this.deliver(route, row.id);
        dispatched.push(row.id);
      } catch (error) {
        failed.push(row.id);
        console.error(
          `发件箱投递失败（id=${row.id}, event=${row.eventName}）：`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    await markOutboxDispatched(tx, dispatched);
    await markOutboxFailed(tx, failed, '投递到队列失败，将在下一轮重试');
    return dispatched.length;
  }

  /** 按载荷中的路由投递到目标队列 */
  private async deliver(route: OutboxJobRoute, outboxId: number): Promise<void> {
    if (route.queue === 'workflow') {
      const target = this.queues.workflow;
      await target.add(route.name, route.data as never, {
        jobId: `outbox-${outboxId}`,
        ...(route.delayMs !== undefined ? { delay: route.delayMs } : {}),
      });
      return;
    }
    if (route.queue === 'publishing') {
      const target = this.queues.publishing;
      await target.add(route.name, route.data as never, {
        jobId: `outbox-${outboxId}`,
        ...(route.delayMs !== undefined ? { delay: route.delayMs } : {}),
      });
      return;
    }
    throw new Error(`无法路由的队列：${route.queue}`);
  }
}

/** 从发件箱载荷提取 job 路由；不存在返回 null */
function extractRoute(payload: unknown): OutboxJobRoute | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const job = (payload as { job?: unknown }).job;
  if (typeof job !== 'object' || job === null) {
    return null;
  }
  const candidate = job as Partial<OutboxJobRoute>;
  if (typeof candidate.queue !== 'string' || typeof candidate.name !== 'string') {
    return null;
  }
  return {
    queue: candidate.queue,
    name: candidate.name,
    data: candidate.data ?? {},
    ...(typeof candidate.delayMs === 'number' ? { delayMs: candidate.delayMs } : {}),
  };
}
