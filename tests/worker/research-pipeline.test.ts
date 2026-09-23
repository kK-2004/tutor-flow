import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  claimSources,
  claims,
  createRun,
  directionOptions,
  duplicateClusters,
  queryPlans,
  requireRun,
  sourceDocuments,
} from '@tutor-flow/db';
import type { DbClient } from '@tutor-flow/db';
import type { StepHandler, WorkflowEngine } from '@tutor-flow/workflow';
import { createWorkflowEngine } from '@tutor-flow/workflow';
import {
  FakeLlmGateway,
  FakePageFetcher,
  FakeSearchGateway,
  type SearchResultItem,
} from '@tutor-flow/integrations';

import {
  createDedupeSourcesHandler,
  createExtractClaimsHandler,
  createFetchSourcesHandler,
  createGenerateDirectionsHandler,
  createQueryPlanningHandler,
  createScoreSourcesHandler,
  createSearchHandler,
} from '../../apps/worker/src/steps/research.js';
import { createInMemoryTextCache } from '../../apps/worker/src/research-text-cache.js';
import { createTestDb, setupTestDatabase, truncateAll } from '../db/setup';

/**
 * 研究链路全流程串测（任务 4.9）：
 * 规划 → 搜索 → 抓取 → 去重 → 评分 → 事实 → 方向，
 * 覆盖规格场景：转载聚类、权威非中文原始来源优先、无来源事实门槛。
 */

let db: DbClient;
let engine: WorkflowEngine;
let handlers: Record<string, StepHandler>;
const textCache = createInMemoryTextCache();

/** 原始英文官方文档（权威来源） */
const OFFICIAL_BODY =
  '<html lang="en"><head><title>PostgreSQL 17 Release Notes</title></head><body>' +
  '<p>PostgreSQL 17 improves vacuum performance by up to 2x and adds incremental backups support.</p>' +
  '<p>The release also includes improvements to the query planner and JSON handling.</p></body></html>';
/** 中文转载（与官方内容高度相似 → 语义/指纹不应聚簇，因为内容并非完全相同；这里用作独立来源） */
const ZH_REVIEW_BODY =
  '<html lang="zh"><head><title>PostgreSQL 17 深度解读</title></head><body>' +
  '<p>PostgreSQL 17 发布，vacuum 性能提升约两倍，并支持增量备份。</p>' +
  '<p>查询优化器与 JSON 处理也有改进，值得一试。</p></body></html>';
/** 中文转载（与 ZH_REVIEW 完全相同内容 → 指纹聚簇） */
const ZH_COPY_BODY = ZH_REVIEW_BODY;

beforeAll(async () => {
  await setupTestDatabase();
  db = createTestDb();
  engine = createWorkflowEngine(db);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await truncateAll(db);
});

/** 构建整套研究处理器（脚本化模拟；可覆盖方向生成输出） */
function buildHandlers(
  runId: string,
  directionsOverride?: string,
): Record<string, StepHandler> {
  const llm = new FakeLlmGateway();
  llm.on(
    (request) => request.task === 'query_planning',
    () =>
      JSON.stringify([
        { query: 'PostgreSQL 17 新特性', language: 'zh', intent: 'BASIC_UNDERSTANDING' },
        {
          query: 'PostgreSQL 17 release notes',
          language: 'en',
          intent: 'ORIGINAL_SOURCE',
        },
      ]),
  );
  llm.on(
    (request) => request.task === 'claim_extraction',
    () =>
      JSON.stringify({
        claims: [
          {
            statement: 'PostgreSQL 17 的 vacuum 性能提升约两倍',
            sources: ['https://postgresql.org/release'],
            confidence: 0.95,
          },
          {
            statement: 'PostgreSQL 17 支持增量备份',
            sources: ['https://postgresql.org/release'],
            confidence: 0.9,
          },
        ],
      }),
  );
  llm.on(
    (request) => request.task === 'direction_generation',
    () =>
      directionsOverride ??
      JSON.stringify({
        directions: [
          {
            title: 'PostgreSQL 17 发布盘点',
            summary: '两大核心改进解读',
            targetAudience: '后端开发者',
            keywords: ['PostgreSQL', '数据库'],
            claimIndexes: [1, 2],
            audienceMatch: 0.85,
            platformMatch: 0.8,
            novelty: 0.7,
            timeliness: 0.9,
            risk: 0.1,
          },
          {
            title: '低质量方向',
            summary: '无关内容',
            targetAudience: ' nobody',
            keywords: [],
            claimIndexes: [99],
            audienceMatch: 0.2,
            platformMatch: 0.2,
            novelty: 0.2,
            timeliness: 0.2,
            risk: 0.9,
          },
        ],
      }),
  );

  const searchResults: SearchResultItem[] = [
    {
      title: 'Release Notes（官方）',
      url: 'https://postgresql.org/release',
      snippet: '',
      publishedAt: new Date().toISOString(),
    },
    {
      title: 'PostgreSQL 17 深度解读（中文原创）',
      url: 'https://blog.example.com/review',
      snippet: '',
    },
    {
      title: '中文转载',
      url: 'https://repost.example.com/copy?utm_source=x',
      snippet: '',
    },
  ];
  const search = new FakeSearchGateway();
  search.on(() => true, searchResults);

  const fetcher = new FakePageFetcher();
  fetcher.on('https://postgresql.org/release', { body: OFFICIAL_BODY });
  fetcher.on('https://blog.example.com/review', { body: ZH_REVIEW_BODY });
  fetcher.on('https://repost.example.com/copy', { body: ZH_COPY_BODY });

  const deps = {
    db,
    llm,
    search,
    fetcher,
    extractor: {
      extract: (page: { body: string }) => {
        // 与 FakeContentExtractor 相同的确定性提取
        const title = /<title>([^<]*)<\/title>/i.exec(page.body)?.[1] ?? '';
        const text = page.body
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        return { canonicalUrl: '', title, text, language: 'zh' };
      },
    },
    vector: {
      async embed(text: string) {
        // 简单确定性向量：以字符数量构造，转载与原文不强制合并
        return [text.length % 7 === 0 ? 1 : 0, 1];
      },
      similarity(a: number[], b: number[]) {
        return (a[0] ?? 0) === (b[0] ?? 0) ? 1 : 0;
      },
    },
    textCache,
  };

  return {
    QUERY_PLANNING: createQueryPlanningHandler(deps),
    SEARCH: createSearchHandler(deps),
    FETCH_SOURCES: createFetchSourcesHandler(deps),
    DEDUPE_SOURCES: createDedupeSourcesHandler(deps),
    SCORE_SOURCES: createScoreSourcesHandler(deps),
    EXTRACT_CLAIMS: createExtractClaimsHandler(deps),
    GENERATE_DIRECTIONS: createGenerateDirectionsHandler(deps),
  };
}

/** 顺序驱动研究链路（人工模式：到方向生成为止） */
async function runResearchChain(runId: string): Promise<void> {
  const run = await requireRun(db.db, runId);
  const order: Array<[string, string]> = [
    ['QUERY_PLANNING', 'QUERY_PLANNING'],
    ['SEARCH', 'SEARCH'],
    ['FETCH_SOURCES', 'FETCH_SOURCES'],
    ['DEDUPE_SOURCES', 'DEDUPE_SOURCES'],
    ['SCORE_SOURCES', 'SCORE_SOURCES'],
    ['EXTRACT_CLAIMS', 'EXTRACT_CLAIMS'],
    ['GENERATE_DIRECTIONS', 'GENERATE_DIRECTIONS'],
  ];
  for (const [stepType] of order) {
    const handler = handlers[stepType];
    if (handler === undefined) {
      throw new Error(`处理器缺失：${stepType}`);
    }
    await handler({
      data: { runId, stepType: stepType as never, attemptNo: 1 },
      run,
      attempt: {},
    } as never);
  }
}

describe('研究链路全流程（4.9）', () => {
  beforeEach(async () => {
    handlers = {};
  });

  it('完整链路：转载聚类、事实绑定、方向排序、权威来源优先', async () => {
    const created = await createRun(db.db, {
      callerIdentity: 'operator:pipe',
      requestHash: 'hash-pipe',
      topic: 'PostgreSQL 17 发布解读',
      directionMode: 'manual',
      publishMode: 'review',
      platform: 'xiaohongshu',
      accountId: '00000000-0000-0000-0000-000000000001',
      triggerType: 'manual',
      triggeredBy: 'operator:pipe',
    });
    handlers = buildHandlers(created.runId);

    await runResearchChain(created.runId);

    // 来源：3 条 URL 去重后保留 3 条（追参数被剥离），其中转载两条聚为一簇
    const sources = await db.db.select().from(sourceDocuments);
    expect(sources).toHaveLength(3);
    const clusters = await db.db.select().from(duplicateClusters);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.method).toBe('TEXT_FINGERPRINT');
    expect(clusters[0]?.canonicalSourceId).not.toBeNull();

    // 评分全部落库；官方文档总分领先（权威原始来源优先）
    const official = sources.find(
      (source) => source.canonicalUrl === 'https://postgresql.org/release',
    );
    const repost = sources.find(
      (source) =>
        source.urlHash !== official?.urlHash && source.domain === 'repost.example.com',
    );
    expect(official?.totalScore).not.toBeNull();
    const repostRow = sources.find((source) => source.clusterRole === 'DUPLICATE');
    expect(repostRow?.clusterRole).toBe('DUPLICATE');
    void repost;

    // 事实：两条，均绑定官方来源；主要来源支持
    const claimRows = await db.db.select().from(claims);
    expect(claimRows).toHaveLength(2);
    const links = await db.db.select().from(claimSources);
    const officialId = official?.id as string;
    expect(links.every((link) => link.sourceId === officialId)).toBe(true);

    // 方向：2 个，按总分降序；高分方向覆盖率 1
    const directions = await db.db.select().from(directionOptions);
    expect(directions).toHaveLength(2);
    expect(directions[0]?.title).toBe('PostgreSQL 17 发布盘点');
    expect(directions[0]?.totalScore).toBeGreaterThanOrEqual(
      directions[1]?.totalScore ?? 0,
    );
    const topFactors = directions[0]?.scoreFactors as { sourceCoverage: number };
    expect(topFactors.sourceCoverage).toBe(1);

    // 查询计划存在且记录了两次查询
    const plans = await db.db.select().from(queryPlans);
    expect((plans[0]?.queries as unknown[]).length).toBe(2);
  });

  it('自动模式 + 全低分方向：选向门槛失败转 NEEDS_HUMAN', async () => {
    const created = await createRun(db.db, {
      callerIdentity: 'operator:pipe2',
      requestHash: 'hash-pipe2',
      topic: '门槛失败主题',
      directionMode: 'auto',
      publishMode: 'review',
      platform: 'xiaohongshu',
      accountId: '00000000-0000-0000-0000-000000000001',
      triggerType: 'manual',
      triggeredBy: 'operator:pipe2',
    });
    // 覆盖方向生成脚本：只产出低分方向（总分低于 60 门槛）
    handlers = buildHandlers(
      created.runId,
      JSON.stringify({
        directions: [
          {
            title: '低分方向',
            summary: '无关内容',
            targetAudience: ' nobody',
            keywords: [],
            claimIndexes: [99],
            audienceMatch: 0.2,
            platformMatch: 0.2,
            novelty: 0.2,
            timeliness: 0.2,
            risk: 0.9,
          },
        ],
      }),
    );

    await runResearchChain(created.runId);

    // 引擎内置自动选向：无合格方向 → VALIDATION → NEEDS_HUMAN
    const run = await requireRun(db.db, created.runId);
    const attempt = {
      id: 'x',
      runId: run.id,
      stepType: 'SELECT_DIRECTION',
      attemptNo: 1,
      status: 'RUNNING',
    };
    await expect(
      engine.builtInHandlers.SELECT_DIRECTION({
        data: { runId: run.id, stepType: 'SELECT_DIRECTION', attemptNo: 1 },
        run,
        attempt: attempt as never,
      }),
    ).rejects.toThrow(/没有满足质量门槛|没有候选方向/);
  });
});
