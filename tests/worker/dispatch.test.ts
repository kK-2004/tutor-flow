import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createRun, stepRuns, transitionRunStatus } from '@tutor-flow/db';
import type { DbClient } from '@tutor-flow/db';
import { and, eq } from 'drizzle-orm';
import { Queue, type Job } from 'bullmq';
import { Redis } from 'ioredis';

import { createStepProcessor, StepFailure } from '@tutor-flow/workflow';
import { OutboxDispatcher } from '../../apps/worker/src/dispatcher.js';
import { createConnection, createQueues } from '../../apps/worker/src/queues.js';
import type { StepJobData } from '../../apps/worker/src/queues.js';

import { createTestDb, setupTestDatabase, truncateAll } from '../db/setup';
import { isRedisAvailable } from './redis';

/**
 * 发件箱分发与幂等步骤处理器集成测试。
 *
 * 不创建真实 BullMQ Worker：投递到队列后手动取出任务并调用
 * 处理器函数，避免真实消费带来的时序竞态。
 * 依赖本地 SQLite 与本地 Redis（已部署实例，无 Redis 时自动跳过）。
 */

const REDIS_URL = process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379';

// 本项目不部署 Redis：无 Redis 环境下自动跳过队列集成测试
const redisReady = await isRedisAvailable();
if (!redisReady) {
  console.warn('Redis 不可用，跳过队列集成测试');
}

let db: DbClient;
let dispatcher: OutboxDispatcher;
let queue: Queue<StepJobData>;
let connection: Redis;
let processor: ReturnType<typeof createStepProcessor>;

/** QUERY_PLANNING 处理器的执行计数（验证幂等） */
let planningExecutions: number;
/** 注册一个总是失败的处理器的开关 */
let failNextPlanning: boolean;

beforeAll(async () => {
  await setupTestDatabase();
  db = createTestDb();
  connection = createConnection(REDIS_URL);
  const queues = createQueues(connection);
  queue = queues.workflow;
  dispatcher = new OutboxDispatcher(db, queues, { intervalMs: 60_000 });
  processor = createStepProcessor({
    db,
    handlers: {
      QUERY_PLANNING: async () => {
        if (failNextPlanning) {
          throw new StepFailure('TRANSIENT', '模拟搜索网关超时');
        }
        planningExecutions += 1;
        return { outputRef: 'query-plan-1' };
      },
    },
  });
});

afterAll(async () => {
  // 无 Redis 场景下不触碰队列连接
  if (redisReady) {
    await queue.close();
    await connection.quit();
  }
  await db?.close();
});

beforeEach(async () => {
  // 无 Redis 时队列测试整体跳过，钩子直接返回
  if (!redisReady) {
    return;
  }
  await truncateAll(db);
  planningExecutions = 0;
  failNextPlanning = false;
  await queue.obliterate({ force: true });
});

/** 取出队列中的全部等待任务并手动执行处理器 */
async function drainManually(): Promise<number> {
  const waiting = await queue.getWaiting();
  for (const job of waiting) {
    await processor(job as Job<StepJobData>);
  }
  return waiting.length;
}

/** 通用运行任务创建 + 分发 */
async function seedQueuedRun(caller: string, topic: string): Promise<string> {
  const created = await createRun(db.db, {
    callerIdentity: caller,
    requestHash: `hash-${topic}`,
    topic,
    directionMode: 'manual',
    publishMode: 'review',
    platform: 'xiaohongshu',
    accountId: '00000000-0000-0000-0000-000000000001',
    triggerType: 'manual',
    triggeredBy: caller,
  });
  const dispatched = await dispatcher.dispatchOnce();
  expect(dispatched).toBe(1);
  return created.runId;
}

describe.skipIf(!redisReady)('事务性发件箱分发', () => {
  it('创建运行后分发器把任务投递到工作流队列并标记已分发', async () => {
    const runId = await seedQueuedRun('operator:test', '分发测试');

    const counts = await queue.getJobCounts('waiting');
    expect(counts.waiting).toBe(1);

    // 手动消费：步骤尝试写入并成功
    const processed = await drainManually();
    expect(processed).toBe(1);

    const attempts = await db.db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe('SUCCEEDED');
    expect(attempts[0]?.outputRef).toBe('query-plan-1');
  });

  it('再次分发不会重复投递已分发记录', async () => {
    await seedQueuedRun('operator:test', '幂等分发测试');
    expect(await dispatcher.dispatchOnce()).toBe(0);
  });

  it('分发与业务写入不跨事务：分发后 outbox 已标记', async () => {
    await seedQueuedRun('operator:test', '标记检查');
    const rows = await db.db
      .select()
      .from((await import('@tutor-flow/db')).outboxRecords);
    expect(rows[0]?.dispatchedAt).not.toBeNull();
  });
});

describe.skipIf(!redisReady)('幂等步骤处理器', () => {
  it('重复投递同一尝试只执行一次业务处理器', async () => {
    const runId = await seedQueuedRun('operator:op-9', '中间件测试');
    expect(await drainManually()).toBe(1);
    expect(planningExecutions).toBe(1);

    // 模拟过期投递：再次执行相同任务，处理器不得重复运行
    const firstJob = {
      data: { runId, stepType: 'QUERY_PLANNING', attemptNo: 1 },
    } as Job<StepJobData>;
    await processor(firstJob);
    expect(planningExecutions).toBe(1);
  });

  it('分类失败写入错误分类且事件可查', async () => {
    const runId = await seedQueuedRun('operator:op-9', '失败分类测试');
    failNextPlanning = true;
    // 第一次投递的任务以失败处理器执行
    await drainManually();

    const attempts = await db.db
      .select()
      .from(stepRuns)
      .where(and(eq(stepRuns.runId, runId), eq(stepRuns.attemptNo, 1)));
    expect(attempts[0]?.status).toBe('FAILED');
    expect(attempts[0]?.errorCategory).toBe('TRANSIENT');
    expect(attempts[0]?.errorMessage).toContain('模拟搜索网关超时');
  });

  it('研究阶段的运行状态推进后处理器仍可执行', async () => {
    const runId = await seedQueuedRun('operator:op-9', '状态推进测试');
    await transitionRunStatus(db.db, runId, 'RESEARCHING', { expectedVersion: 1 });
    expect(await drainManually()).toBe(1);
    expect(planningExecutions).toBe(1);
  });
});
