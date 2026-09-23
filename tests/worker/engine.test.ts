import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  computeRetryBackoffMs,
  createStepProcessor,
  createWorkflowEngine,
  planNextStep,
  type StepHandler,
} from '@tutor-flow/workflow';
import { OutboxDispatcher } from '../../apps/worker/src/dispatcher.js';
import { createConnection, createQueues } from '../../apps/worker/src/queues.js';
import { StepFailure } from '@tutor-flow/workflow';
import type { StepType } from '@tutor-flow/domain';
import {
  claimSources,
  claims,
  createRun,
  directionClaims,
  directionOptions,
  listDirectionOptions,
  listEventsAfter,
  outboxRecords,
  requireRun,
  sourceDocuments,
  stepRuns,
  transitionRunStatus,
} from '@tutor-flow/db';
import type { DbClient } from '@tutor-flow/db';
import { and, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';

import { createTestDb, setupTestDatabase, truncateAll } from '../db/setup';
import { isRedisAvailable } from './redis';

/**
 * 工作流引擎集成测试：检查点推进、人工停点、恢复扫描与取消。
 * 手动驱动分发与处理器，避免真实 Worker 的时序竞态。
 * 依赖本地 SQLite 与本地 Redis（已部署实例，无 Redis 时自动跳过）。
 */

const REDIS_URL = process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379';

// 本项目不部署 Redis：无 Redis 环境下自动跳过队列集成测试
const redisReady = await isRedisAvailable();
if (!redisReady) {
  console.warn('Redis 不可用，跳过队列集成测试');
}

let db: DbClient;
let engine: ReturnType<typeof createWorkflowEngine>;
let processor: ReturnType<typeof createStepProcessor>;
let dispatcher: OutboxDispatcher;
let queue: import('bullmq').Queue;
let connection: Redis;

/** 透传成功处理器：只推进状态机，不做业务 */
const passThrough: StepHandler = async () => ({});

/** 在 GENERATE_DIRECTIONS 插入带事实来源关联的高分候选方向后成功 */
const generateOneDirection: StepHandler = async ({ run }) => {
  // 来源 → 事实 → 方向关联：保证自动选向的覆盖率计算有依据
  const [source] = await db.db
    .insert(sourceDocuments)
    .values({
      runId: run.id,
      canonicalUrl: 'https://example.com/a',
      urlHash: 'hash-a',
      title: '来源 A',
      domain: 'example.com',
      language: 'zh',
      sourceType: 'OFFICIAL_DOCS',
      fetchStatus: 'FETCHED',
      isPrimary: true,
      totalScore: 80,
    })
    .returning();
  const [claim] = await db.db
    .insert(claims)
    .values({
      runId: run.id,
      statement: '事实 A',
      confidence: 0.9,
      primarySourceSupported: true,
    })
    .returning();
  await db.db.insert(claimSources).values({ claimId: claim.id, sourceId: source.id });

  const [direction] = await db.db
    .insert(directionOptions)
    .values({
      runId: run.id,
      title: '方向 A',
      summary: '摘要',
      targetAudience: '运营人员',
      keywords: ['关键词'],
      scoreFactors: {
        sourceCoverage: 1,
        audienceMatch: 0.8,
        platformMatch: 0.8,
        novelty: 0.5,
        timeliness: 0.5,
        risk: 0.1,
      },
      totalScore: 88,
      rank: 1,
      scoringInputs: { thresholdSnapshot: {}, rankedAt: new Date().toISOString() },
    })
    .returning();
  await db.db
    .insert(directionClaims)
    .values({ directionId: direction.id, claimId: claim.id });
  return { outputRef: direction.id };
};

const testHandlers: Partial<Record<StepType, StepHandler>> = {
  QUERY_PLANNING: passThrough,
  CREATE_DRAFT: passThrough,
  SEARCH: passThrough,
  FETCH_SOURCES: passThrough,
  DEDUPE_SOURCES: passThrough,
  SCORE_SOURCES: passThrough,
  EXTRACT_CLAIMS: passThrough,
  GENERATE_DIRECTIONS: generateOneDirection,
  GENERATE_CANONICAL: passThrough,
  ADAPT_XIAOHONGSHU: passThrough,
  MODERATE_CONTENT: passThrough,
};

beforeAll(async () => {
  await setupTestDatabase();
  db = createTestDb();
  engine = createWorkflowEngine(db);
  processor = createStepProcessor({
    db,
    handlers: { ...engine.builtInHandlers, ...testHandlers },
    onStepSuccess: async ({ run, data }) => {
      await engine.advanceAfterStep(run.id, data.stepType);
    },
    onStepFailure: async ({ run, data, attempt, category, message }) => {
      await engine.handleStepFailure(run.id, {
        stepType: data.stepType,
        stepRunId: attempt.id,
        attemptNo: attempt.attemptNo,
        category,
        message,
      });
    },
  });
  connection = createConnection(REDIS_URL);
  const queues = createQueues(connection);
  queue = queues.workflow;
  dispatcher = new OutboxDispatcher(db, queues, { intervalMs: 60_000 });
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
  await queue.obliterate({ force: true });
});

/** 手动驱动：分发 → 消费，循环直到队列与发件箱都清空 */
async function drive(maxRounds = 30): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    const dispatched = await dispatcher.dispatchOnce();
    const waiting = await queue.getWaiting();
    if (dispatched === 0 && waiting.length === 0) {
      return;
    }
    for (const job of waiting) {
      await processor(job as never);
      // 手动驱动不会自动完成任务，处理完直接移除
      await job.remove().catch(() => undefined);
    }
  }
  throw new Error('驱动循环在最大轮数内未收敛');
}

/** 通用运行创建输入 */
function runInput(caller: string, topic: string, directionMode: 'auto' | 'manual') {
  return {
    callerIdentity: caller,
    requestHash: `hash-${topic}`,
    topic,
    directionMode,
    publishMode: 'review' as const,
    platform: 'xiaohongshu' as const,
    accountId: '00000000-0000-0000-0000-000000000001',
    triggerType: 'manual' as const,
    triggeredBy: caller,
  };
}

describe('planNextStep 纯函数', () => {
  it('人工模式在方向生成后停点等待', () => {
    const plan = planNextStep({
      completedStep: 'GENERATE_DIRECTIONS',
      directionMode: 'manual',
      publishMode: 'review',
    });
    expect(plan.stop).toBe('WAITING_DIRECTION');
    expect(plan.status).toBe('WAITING_DIRECTION');
  });

  it('自动模式继续执行引擎选向步骤', () => {
    const plan = planNextStep({
      completedStep: 'GENERATE_DIRECTIONS',
      directionMode: 'auto',
      publishMode: 'review',
      requireHumanApproval: false,
    });
    expect(plan.nextStep).toBe('SELECT_DIRECTION');
  });

  it('强制人工审核开启时 auto 模式也走草稿箱', () => {
    const plan = planNextStep({
      completedStep: 'CREATE_DRAFT',
      directionMode: 'auto',
      publishMode: 'auto',
      requireHumanApproval: true,
    });
    expect(plan.stop).toBe('NEEDS_REVIEW');
    expect(plan.status).toBe('NEEDS_REVIEW');
  });

  it('人工审核模式：审核后先建草稿，再进入草稿箱停点', () => {
    const plan = planNextStep({
      completedStep: 'MODERATE_CONTENT',
      directionMode: 'auto',
      publishMode: 'review',
      requireHumanApproval: true,
    });
    expect(plan.nextStep).toBe('CREATE_DRAFT');

    const plan2 = planNextStep({
      completedStep: 'CREATE_DRAFT',
      directionMode: 'auto',
      publishMode: 'review',
      requireHumanApproval: true,
    });
    expect(plan2.stop).toBe('NEEDS_REVIEW');
    expect(plan2.status).toBe('NEEDS_REVIEW');
  });

  it('发布核验完成进入成功终态', () => {
    const plan = planNextStep({
      completedStep: 'VERIFY_PUBLICATION',
      directionMode: 'manual',
      publishMode: 'review',
    });
    expect(plan.terminal).toBe(true);
    expect(plan.status).toBe('SUCCEEDED');
  });

  it('退避延迟随尝试次数增长且有上界', () => {
    expect(computeRetryBackoffMs(1)).toBeLessThanOrEqual(computeRetryBackoffMs(2));
    expect(computeRetryBackoffMs(10)).toBeLessThanOrEqual(60_500);
  });
});

describe.skipIf(!redisReady)('检查点推进与人工停点', () => {
  it('人工模式推进到 WAITING_DIRECTION，选向后推进到 NEEDS_REVIEW', async () => {
    const created = await createRun(
      db.db,
      runInput('operator:e2e', '引擎全链路测试', 'manual'),
    );

    await drive();

    // 推进到人工选向停点
    let run = await requireRun(db.db, created.runId);
    expect(run.status).toBe('WAITING_DIRECTION');
    const directions = await listDirectionOptions(db.db, created.runId);
    expect(directions).toHaveLength(1);
    const directionId = directions[0]?.id;
    expect(directionId).toBeDefined();

    // 人工选向恢复
    await engine.resumeWithDirection(
      created.runId,
      directionId as string,
      'operator:e2e',
    );
    run = await requireRun(db.db, created.runId);
    expect(run.status).toBe('GENERATING');

    // 继续推进到草稿审核停点
    await drive();
    run = await requireRun(db.db, created.runId);
    expect(run.status).toBe('NEEDS_REVIEW');
  });
});

describe.skipIf(!redisReady)('恢复扫描', () => {
  it('重启后恢复扫描重新入队未完成检查点', async () => {
    const created = await createRun(
      db.db,
      runInput('operator:recover', '恢复扫描测试', 'manual'),
    );

    // 模拟崩溃：运行在 RESEARCHING、当前步骤 SEARCH，队列任务与发件箱记录均已丢失
    await transitionRunStatus(db.db, created.runId, 'RESEARCHING', {
      expectedVersion: 1,
      currentStepType: 'SEARCH',
    });
    await db.db.update(outboxRecords).set({ dispatchedAt: new Date() });

    const recovered = await engine.recoverInterruptedRuns();
    expect(recovered).toBe(1);

    // 恢复后继续推进到 WAITING_DIRECTION
    await drive();
    const run = await requireRun(db.db, created.runId);
    expect(run.status).toBe('WAITING_DIRECTION');
  });
});

describe.skipIf(!redisReady)('取消', () => {
  it('人工停点状态下的取消立即终态化', async () => {
    const created = await createRun(
      db.db,
      runInput('operator:cancel', '取消测试', 'manual'),
    );

    await drive();
    await engine.cancelRun(created.runId, 'operator:cancel', '不再需要');

    const run = await requireRun(db.db, created.runId);
    expect(run.status).toBe('CANCELLED');
    expect(run.cancelRequested).toBe(true);

    const events = await listEventsAfter(db.db, created.runId);
    expect(events.some((e) => e.name === 'run.cancelled')).toBe(true);
  });

  it('执行中运行请求取消后，检查点不再派发新工作', async () => {
    const created = await createRun(
      db.db,
      runInput('operator:cancel2', '执行中取消测试', 'manual'),
    );
    // 直接标记取消请求（模拟执行中取消）
    await engine.cancelRun(created.runId, 'operator:cancel2', '中途取消');

    // 取消请求已标记；驱动循环不再推进到 WAITING_DIRECTION
    await drive();
    const run = await requireRun(db.db, created.runId);
    expect(['CANCELLED', 'RESEARCHING']).toContain(run.status);
    if (run.status === 'RESEARCHING') {
      expect(run.cancelRequested).toBe(true);
    }
  });
});

describe.skipIf(!redisReady)('自动选向门槛', () => {
  const autoHandlers: Partial<Record<StepType, StepHandler>> = {
    ...testHandlers,
    GENERATE_DIRECTIONS: async ({ run }) => {
      // 插入一个低于门槛的方向（总分 20 < 默认 60）
      await db.db.insert(directionOptions).values({
        runId: run.id,
        title: '低分方向',
        summary: '摘要',
        targetAudience: '运营人员',
        keywords: ['关键词'],
        scoreFactors: {
          sourceCoverage: 0.2,
          audienceMatch: 0.2,
          platformMatch: 0.2,
          novelty: 0.1,
          timeliness: 0.1,
          risk: 0.9,
        },
        totalScore: 20,
        rank: 1,
        scoringInputs: { thresholdSnapshot: {}, rankedAt: new Date().toISOString() },
      });
      return { outputRef: 'low-direction' };
    },
  };

  it('自动模式下无合格方向时转入 NEEDS_HUMAN', async () => {
    const autoProcessor = createStepProcessor({
      db,
      handlers: { ...engine.builtInHandlers, ...autoHandlers },
      onStepSuccess: async ({ run, data }) => {
        await engine.advanceAfterStep(run.id, data.stepType);
      },
      onStepFailure: async ({ run, data, attempt, category, message }) => {
        await engine.handleStepFailure(run.id, {
          stepType: data.stepType,
          stepRunId: attempt.id,
          attemptNo: attempt.attemptNo,
          category,
          message,
        });
      },
    });
    const created = await createRun(
      db.db,
      runInput('operator:auto1', '自动选向低分测试', 'auto'),
    );
    // 手动驱动：使用低分方向的处理器集合
    for (let i = 0; i < 20; i++) {
      const dispatched = await dispatcher.dispatchOnce();
      const waiting = await queue.getWaiting();
      if (dispatched === 0 && waiting.length === 0) {
        break;
      }
      for (const job of waiting) {
        await autoProcessor(job as never);
        await job.remove().catch(() => undefined);
      }
    }
    const run = await requireRun(db.db, created.runId);
    expect(run.status).toBe('NEEDS_HUMAN');

    // 事件流包含选向决策与转人工事件
    const events = await listEventsAfter(db.db, created.runId);
    expect(events.some((e) => e.name === 'run.needs_human')).toBe(true);
  });

  it('自动模式下存在合格方向时选择最高分并继续生成', async () => {
    const created = await createRun(
      db.db,
      runInput('operator:auto2', '自动选向高分测试', 'auto'),
    );
    await drive();

    // 走到 NEEDS_REVIEW（publishMode review 停点）说明选向成功
    const run = await requireRun(db.db, created.runId);
    expect(run.status).toBe('NEEDS_REVIEW');
    const events = await listEventsAfter(db.db, created.runId);
    const selected = events.find((e) => e.name === 'run.direction_selected');
    expect(selected).toBeDefined();
    expect((selected?.payload as { mode?: string }).mode).toBe('auto');
  });
});

describe.skipIf(!redisReady)('失败重试与人工处置', () => {
  it('可重试瞬时错误进入 RETRY_WAIT 并安排下一次尝试', async () => {
    let failSearch = true;
    const retryHandlers: Partial<Record<StepType, StepHandler>> = {
      ...testHandlers,
      SEARCH: async () => {
        if (failSearch) {
          throw new StepFailure('TRANSIENT', '搜索网关超时');
        }
        return passThrough();
      },
    };
    const retryProcessor = createStepProcessor({
      db,
      handlers: { ...engine.builtInHandlers, ...retryHandlers },
      onStepSuccess: async ({ run, data }) => {
        await engine.advanceAfterStep(run.id, data.stepType);
      },
      onStepFailure: async ({ run, data, attempt, category, message }) => {
        await engine.handleStepFailure(run.id, {
          stepType: data.stepType,
          stepRunId: attempt.id,
          attemptNo: attempt.attemptNo,
          category,
          message,
        });
      },
    });

    const created = await createRun(
      db.db,
      runInput('operator:retry', '退避重试测试', 'manual'),
    );
    // 分发并消费：QUERY_PLANNING 成功 → SEARCH 失败（驱动至进入 RETRY_WAIT）
    for (let i = 0; i < 6; i++) {
      await dispatcher.dispatchOnce();
      const pending = await queue.getWaiting();
      if (pending.length === 0) {
        break;
      }
      for (const job of pending) {
        await retryProcessor(job as never);
        await job.remove().catch(() => undefined);
      }
    }

    const run = await requireRun(db.db, created.runId);
    expect(run.status).toBe('RETRY_WAIT');

    // 修复故障后处理延迟重试任务（attempt 2）
    failSearch = false;
    const delayed = await queue.getDelayed();
    expect(delayed.length).toBeGreaterThan(0);
    for (const job of delayed) {
      await retryProcessor(job as never);
      await job.remove().catch(() => undefined);
    }

    // SEARCH 尝试 2 成功 → 推进恢复
    const runAfter = await requireRun(db.db, created.runId);
    expect(['RESEARCHING', 'WAITING_DIRECTION']).toContain(runAfter.status);

    // 尝试记录保留用于审计
    const attempts = await db.db
      .select()
      .from(stepRuns)
      .where(and(eq(stepRuns.runId, created.runId), eq(stepRuns.stepType, 'SEARCH')));
    expect(attempts.map((a) => a.attemptNo).sort()).toEqual([1, 2]);
  });

  it('人工处理类错误拒绝重试并给出所需操作', async () => {
    const failFetch = true;
    const humanHandlers: Partial<Record<StepType, StepHandler>> = {
      ...testHandlers,
      FETCH_SOURCES: async () => {
        if (failFetch) {
          throw new StepFailure('SELECTOR', '小红书页面结构变化');
        }
        return passThrough();
      },
    };
    const humanProcessor = createStepProcessor({
      db,
      handlers: { ...engine.builtInHandlers, ...humanHandlers },
      onStepSuccess: async ({ run, data }) => {
        await engine.advanceAfterStep(run.id, data.stepType);
      },
      onStepFailure: async ({ run, data, attempt, category, message }) => {
        await engine.handleStepFailure(run.id, {
          stepType: data.stepType,
          stepRunId: attempt.id,
          attemptNo: attempt.attemptNo,
          category,
          message,
        });
      },
    });

    const created = await createRun(
      db.db,
      runInput('operator:human', '转人工测试', 'manual'),
    );
    // 消费前两步（QUERY_PLANNING、SEARCH 成功），FETCH_SOURCES 失败
    await dispatcher.dispatchOnce();
    for (let i = 0; i < 6; i++) {
      const waitingJobs = await queue.getWaiting();
      if (waitingJobs.length === 0) {
        break;
      }
      for (const job of waitingJobs) {
        await humanProcessor(job as never);
        await job.remove().catch(() => undefined);
      }
      await dispatcher.dispatchOnce();
    }

    const run = await requireRun(db.db, created.runId);
    expect(run.status).toBe('NEEDS_HUMAN');

    // 人工处理类错误拒绝重试并说明所需操作
    await expect(engine.retryStep(created.runId, 'operator:human')).rejects.toThrow(
      /需要人工处理/,
    );
  });
});

describe.skipIf(!redisReady)('发件箱与状态一致性', () => {
  it('推进链路中运行的 outbox 均被标记分发', async () => {
    const created = await createRun(
      db.db,
      runInput('operator:consistency', '一致性测试', 'manual'),
    );
    await drive();
    const rows = await db.db
      .select()
      .from(outboxRecords)
      .where(eq(outboxRecords.aggregateId, created.runId));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.dispatchedAt).not.toBeNull();
    }
  });
});
