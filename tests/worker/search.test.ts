import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createRun, queryPlans, requireRun, sourceDocuments } from '@tutor-flow/db';
import type { DbClient } from '@tutor-flow/db';
import {
  createBraveSearchGateway,
  FakeSearchGateway,
  GatewayError,
} from '@tutor-flow/integrations';
import type { StepHandler } from '@tutor-flow/workflow';

import {
  createQueryPlanningHandler,
  createSearchHandler,
} from '../../apps/worker/src/steps/research.js';
import { createTestDb, setupTestDatabase, truncateAll } from '../db/setup';

/**
 * Brave 适配器与搜索步骤测试：
 * 摘要仅作召回元数据、部分失败继续处理、来源按规范 URL 去重落库。
 */

let db: DbClient;
let planning: StepHandler;
let search: StepHandler;
let fakeSearch: FakeSearchGateway;

beforeAll(async () => {
  await setupTestDatabase();
  db = createTestDb();
  fakeSearch = new FakeSearchGateway();
  const llmResponse = JSON.stringify([
    { query: '查询 A', language: 'zh', intent: 'BASIC_UNDERSTANDING' },
    { query: '查询 B', language: 'zh', intent: 'RECENCY' },
  ]);
  const llm = {
    complete: async () => ({
      text: llmResponse,
      provider: 'fake',
      model: 'fake-model-1',
      usage: { promptTokens: 10, completionTokens: 10 },
    }),
  };
  planning = createQueryPlanningHandler({ db, llm });
  search = createSearchHandler({ db, search: fakeSearch });
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await truncateAll(db);
  fakeSearch.calls.length = 0;
});

/** 创建运行并完成查询规划 */
async function seedPlannedRun(topic = '搜索测试主题') {
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
  const run = await requireRun(db.db, created.runId);
  const ctx = {
    data: { runId: run.id, stepType: 'QUERY_PLANNING' as const, attemptNo: 1 },
    run,
    attempt: {},
  } as never;
  await planning(ctx);
  return run;
}

describe('Brave Search 适配器', () => {
  it('映射结果字段且不虚构缺失字段', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          web: {
            results: [
              { title: '结果一', url: 'https://example.com/a', description: '摘要一' },
              { url: 'https://example.com/b' },
            ],
          },
        }),
        { status: 200 },
      )) as typeof fetch;
    const gateway = createBraveSearchGateway({ apiKey: 'token', fetchImpl });
    const results = await gateway.search({
      query: 'q',
      language: 'zh',
      intent: 'BASIC_UNDERSTANDING',
      maxResults: 5,
    });
    expect(results).toHaveLength(2);
    expect(results[0]?.snippet).toBe('摘要一');
    expect(results[1]?.title).toBe('https://example.com/b');
    expect(results[1]?.snippet).toBe('');
  });

  it('限流与 5xx 标记为可重试，鉴权失败不可重试', async () => {
    const gateway429 = createBraveSearchGateway({
      apiKey: 't',
      fetchImpl: (async () => new Response(null, { status: 429 })) as typeof fetch,
    });
    await expect(
      gateway429.search({ query: 'q', language: 'zh', intent: 'x', maxResults: 1 }),
    ).rejects.toMatchObject({ retryable: true, status: 429 });

    const gateway500 = createBraveSearchGateway({
      apiKey: 't',
      fetchImpl: (async () => new Response(null, { status: 503 })) as typeof fetch,
    });
    await expect(
      gateway500.search({ query: 'q', language: 'zh', intent: 'x', maxResults: 1 }),
    ).rejects.toMatchObject({ retryable: true });

    const gateway401 = createBraveSearchGateway({
      apiKey: 't',
      fetchImpl: (async () => new Response(null, { status: 401 })) as typeof fetch,
    });
    await expect(
      gateway401.search({ query: 'q', language: 'zh', intent: 'x', maxResults: 1 }),
    ).rejects.toMatchObject({ retryable: false });
    void GatewayError;
  });
});

describe('搜索步骤', () => {
  it('部分失败：成功查询照常落库，失败查询记入部分失败', async () => {
    const run = await seedPlannedRun('部分失败测试');
    fakeSearch.on(
      (q) => q.query === '查询 A',
      [{ title: '来源一', url: 'https://example.com/a?utm_source=x', snippet: '' }],
    );
    fakeSearch.on((q) => q.query === '查询 B', new Error('限流'));

    const output = await search({
      data: { runId: run.id, stepType: 'SEARCH' as const, attemptNo: 1 },
      run,
      attempt: {},
    } as never);

    expect(output.outputRef).toBe('sources-pending:1');
    const sources = await db.db.select().from(sourceDocuments);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.fetchStatus).toBe('PENDING');
    expect(sources[0]?.canonicalUrl).toBe('https://example.com/a');

    const plans = await db.db.select().from(queryPlans);
    const failures = plans[0]?.partialFailures as Array<{ phase: string; query: string }>;
    expect(failures).toHaveLength(1);
    expect(failures[0]?.phase).toBe('search');
    expect(failures[0]?.query).toBe('查询 B');
  });

  it('同一来源的不同追踪参数 URL 去重为一条', async () => {
    const run = await seedPlannedRun('去重测试');
    fakeSearch.on(
      (q) => q.query === '查询 A',
      [{ title: '一', url: 'https://example.com/page', snippet: '' }],
    );
    fakeSearch.on(
      (q) => q.query === '查询 B',
      [{ title: '二', url: 'https://EXAMPLE.com/page/', snippet: '' }],
    );

    await search({
      data: { runId: run.id, stepType: 'SEARCH' as const, attemptNo: 1 },
      run,
      attempt: {},
    } as never);

    const sources = await db.db.select().from(sourceDocuments);
    expect(sources).toHaveLength(1);
  });

  it('全部查询失败且可重试时抛出瞬时错误', async () => {
    const run = await seedPlannedRun('全部失败测试');
    fakeSearch.on(() => true, new GatewayError('网络不可达', { retryable: true }));

    await expect(
      search({
        data: { runId: run.id, stepType: 'SEARCH' as const, attemptNo: 1 },
        run,
        attempt: {},
      } as never),
    ).rejects.toThrow(/全部 2 条查询搜索失败/);
  });
});
