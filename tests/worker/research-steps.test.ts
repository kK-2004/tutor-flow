import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createRun, queryPlans, requireRun } from '@tutor-flow/db';
import type { DbClient } from '@tutor-flow/db';
import type { StepHandler } from '@tutor-flow/workflow';
import { FakeLlmGateway } from '@tutor-flow/integrations';

import {
  createQueryPlanningHandler,
  extractJsonArrayText,
} from '../../apps/worker/src/steps/research.js';
import { createTestDb, setupTestDatabase, truncateAll } from '../db/setup';

/**
 * 查询规划步骤测试：LLM 输出解析、预算截断、部分失败记录与持久化。
 * 依赖本地 SQLite（测试专用临时库）；LLM 使用确定性模拟实现。
 */

let db: DbClient;
let handler: StepHandler;
let llm: FakeLlmGateway;

const planningResponse = JSON.stringify([
  { query: 'PostgreSQL 17 新特性', language: 'zh', intent: 'BASIC_UNDERSTANDING' },
  { query: 'PostgreSQL 17 中文教程', language: 'zh', intent: 'CHINESE_PRIMARY' },
  { query: 'PostgreSQL 17 release notes', language: 'en', intent: 'ORIGINAL_SOURCE' },
  { query: 'PostgreSQL 17 性能优化', language: 'zh', intent: 'BASIC_UNDERSTANDING' },
]);

beforeAll(async () => {
  await setupTestDatabase();
  db = createTestDb();
  llm = new FakeLlmGateway();
  llm.on(
    (request) => request.task === 'query_planning',
    () => planningResponse,
  );
  handler = createQueryPlanningHandler({ db, llm });
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await truncateAll(db);
  llm.calls.length = 0;
});

/** 创建运行并返回运行行 */
async function seedRun(topic = '查询规划测试主题') {
  const created = await createRun(db.db, {
    callerIdentity: 'operator:test',
    requestHash: `hash-${topic}`,
    topic,
    directionMode: 'manual',
    publishMode: 'review',
    platform: 'xiaohongshu',
    accountId: '00000000-0000-0000-0000-000000000001',
    triggerType: 'manual',
    triggeredBy: 'operator:test',
  });
  return requireRun(db.db, created.runId);
}

/** 构造处理器上下文 */
function makeContext(run: Awaited<ReturnType<typeof seedRun>>) {
  return {
    data: { runId: run.id, stepType: 'QUERY_PLANNING' as const, attemptNo: 1 },
    run,
    attempt: {
      id: 'attempt-1',
      runId: run.id,
      stepType: 'QUERY_PLANNING',
      attemptNo: 1,
      status: 'RUNNING',
    },
  } as never;
}

describe('查询规划', () => {
  it('解析 LLM 输出并持久化查询计划与用量', async () => {
    const run = await seedRun();
    const output = await handler(makeContext(run));

    expect(output.outputRef).toBeDefined();
    const plans = await db.db.select().from(queryPlans);
    expect(plans).toHaveLength(1);
    const plan = plans[0];
    expect(plan?.runId).toBe(run.id);
    expect(plan?.model).toBe('fake-model-1');
    expect(plan?.promptVersion).toBe('query-planning@1');
    const queries = plan?.queries as Array<{
      query: string;
      intent: string;
      generatedBy: { model: string };
    }>;
    expect(queries).toHaveLength(4);
    expect(queries[0]?.generatedBy.model).toBe('fake-model-1');
    const usage = plan?.usage as { promptTokens: number; completionTokens: number };
    expect(usage.completionTokens).toBeGreaterThan(0);
  });

  it('超出预算的查询被截断', async () => {
    llm.on(
      (request) => request.task === 'query_planning',
      () =>
        JSON.stringify(
          Array.from({ length: 8 }, (_, i) => ({
            query: `查询 ${i}`,
            language: 'zh',
            intent: 'BASIC_UNDERSTANDING',
          })),
        ),
    );
    const run = await seedRun('预算截断测试');
    await handler(makeContext(run));
    const plan = (await db.db.select().from(queryPlans))[0];
    // 默认预算 maxQueries = 5
    expect((plan?.queries as unknown[]).length).toBe(5);
  });

  it('重复查询被去重并记入部分失败', async () => {
    llm.on(
      (request) => request.task === 'query_planning',
      () =>
        JSON.stringify([
          { query: '相同查询', language: 'zh', intent: 'BASIC_UNDERSTANDING' },
          { query: '相同查询', language: 'zh', intent: 'RECENCY' },
        ]),
    );
    const run = await seedRun('去重测试');
    await handler(makeContext(run));
    const plan = (await db.db.select().from(queryPlans))[0];
    expect((plan?.queries as unknown[]).length).toBe(1);
    const failures = plan?.partialFailures as Array<{ reason: string }>;
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toContain('重复');
  });

  it('LLM 输出无法解析时抛出可重试的瞬时错误', async () => {
    llm.on(
      (request) => request.task === 'query_planning',
      () => '我不会输出 JSON',
    );
    const run = await seedRun('解析失败测试');
    await expect(handler(makeContext(run))).rejects.toThrow(/无法解析/);
    const plans = await db.db.select().from(queryPlans);
    expect(plans).toHaveLength(0);
  });

  it('空规划结果视为瞬时错误', async () => {
    llm.on(
      (request) => request.task === 'query_planning',
      () => '[]',
    );
    const run = await seedRun('空结果测试');
    await expect(handler(makeContext(run))).rejects.toThrow(/为空/);
  });
});

describe('extractJsonArrayText', () => {
  it('容忍 markdown 围栏与前后缀文字', () => {
    const text = '好的，以下是规划：```json\n[{"a":1}]\n``` 以上。';
    expect(extractJsonArrayText(text)).toBe('[{"a":1}]');
  });

  it('无数组时返回 null', () => {
    expect(extractJsonArrayText('没有数组')).toBeNull();
  });
});
