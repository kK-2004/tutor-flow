import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  claimSources,
  createRun,
  directionClaims,
  directionOptions,
  claims,
  requireRun,
  sourceDocuments,
} from '@tutor-flow/db';
import type { DbClient } from '@tutor-flow/db';
import type { StepHandler } from '@tutor-flow/workflow';
import { FakeLlmGateway } from '@tutor-flow/integrations';

import {
  createExtractClaimsHandler,
  createGenerateDirectionsHandler,
} from '../../apps/worker/src/steps/research.js';
import { createInMemoryTextCache } from '../../apps/worker/src/research-text-cache.js';
import { createTestDb, setupTestDatabase, truncateAll } from '../db/setup';

/**
 * 事实抽取与候选方向生成测试：
 * 来源绑定、无来源事实门槛、覆盖率计算、排序与引用落库。
 */

let db: DbClient;
let extractClaims: StepHandler;
let generateDirections: StepHandler;
let llm: FakeLlmGateway;
const textCache = createInMemoryTextCache();

beforeAll(async () => {
  await setupTestDatabase();
  db = createTestDb();
  llm = new FakeLlmGateway();
  extractClaims = createExtractClaimsHandler({ db, llm, textCache });
  generateDirections = createGenerateDirectionsHandler({ db, llm });
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await truncateAll(db);
});

/** 建运行并注入两个已抓取来源（一主要一普通，含缓存正文） */
async function seedRunWithSources(topic = '事实抽取测试') {
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
  const inserted = await db.db
    .insert(sourceDocuments)
    .values([
      {
        runId: run.id,
        canonicalUrl: 'https://postgresql.org/docs',
        urlHash: 'h-docs',
        title: 'PostgreSQL 17 官方文档',
        domain: 'postgresql.org',
        language: 'en',
        fetchStatus: 'FETCHED',
        sourceType: 'OFFICIAL_DOCS',
        isPrimary: true,
        totalScore: 90,
      },
      {
        runId: run.id,
        canonicalUrl: 'https://blog.example.com/post',
        urlHash: 'h-blog',
        title: '技术博客解读',
        domain: 'blog.example.com',
        language: 'zh',
        fetchStatus: 'FETCHED',
        totalScore: 70,
      },
    ])
    .returning();
  for (const row of inserted) {
    await textCache.set(run.id, row.id, `PostgreSQL 17 的资料正文（${row.domain}）`);
  }
  return { run, sources: inserted };
}

describe('事实抽取与核验', () => {
  it('抽取事实并绑定来源，主要来源支持被正确标记', async () => {
    llm.on(
      (request) => request.task === 'claim_extraction',
      () =>
        JSON.stringify({
          claims: [
            {
              statement: 'PostgreSQL 17 带来性能改进',
              sources: ['https://postgresql.org/docs'],
              confidence: 0.9,
            },
            {
              statement: '博客解读认为升级平滑',
              sources: ['https://blog.example.com/post', 'https://postgresql.org/docs'],
              confidence: 0.7,
            },
          ],
        }),
    );
    const { run } = await seedRunWithSources('事实绑定测试');
    const output = await extractClaims({
      data: { runId: run.id, stepType: 'EXTRACT_CLAIMS' as const, attemptNo: 1 },
      run,
      attempt: {},
    } as never);
    expect(output.outputRef).toBe('claims:2');

    const claimRows = await db.db.select().from(claims);
    expect(claimRows).toHaveLength(2);
    const primary = claimRows.find((row) => row.statement.includes('性能改进'));
    expect(primary?.primarySourceSupported).toBe(true);
    const both = claimRows.find((row) => row.statement.includes('升级平滑'));
    expect(both?.primarySourceSupported).toBe(true);

    const links = await db.db.select().from(claimSources);
    expect(links.filter((link) => link.claimId === primary?.id)).toHaveLength(1);
    expect(links.filter((link) => link.claimId === both?.id)).toHaveLength(2);
  });

  it('无有效来源的事实被剔除；全部无来源时转人工（CONTENT）', async () => {
    llm.on(
      (request) => request.task === 'claim_extraction',
      () =>
        JSON.stringify({
          claims: [
            {
              statement: '有效事实',
              sources: ['https://postgresql.org/docs'],
              confidence: 0.8,
            },
            {
              statement: '编造事实',
              sources: ['https://unknown.com/x'],
              confidence: 0.9,
            },
          ],
        }),
    );
    const { run } = await seedRunWithSources('无来源剔除测试');
    const output = await extractClaims({
      data: { runId: run.id, stepType: 'EXTRACT_CLAIMS' as const, attemptNo: 1 },
      run,
      attempt: {},
    } as never);
    expect(output.outputRef).toBe('claims:1');
    const statements = (await db.db.select().from(claims)).map((row) => row.statement);
    expect(statements).toEqual(['有效事实']);

    // 全部无来源 → CONTENT 失败（转人工）
    llm.on(
      (request) => request.task === 'claim_extraction',
      () =>
        JSON.stringify({
          claims: [
            {
              statement: '完全编造',
              sources: ['https://unknown.com/x'],
              confidence: 0.9,
            },
          ],
        }),
    );
    await expect(
      extractClaims({
        data: { runId: run.id, stepType: 'EXTRACT_CLAIMS' as const, attemptNo: 2 },
        run,
        attempt: {},
      } as never),
    ).rejects.toThrow(/全部事实缺少来源支持/);
  });

  it('提示词包含不可信数据边界规则', async () => {
    llm.on(
      (request) => request.task === 'claim_extraction',
      () =>
        JSON.stringify({
          claims: [
            {
              statement: '有效事实',
              sources: ['https://postgresql.org/docs'],
              confidence: 0.9,
            },
          ],
        }),
    );
    const { run } = await seedRunWithSources('边界规则测试');
    await extractClaims({
      data: { runId: run.id, stepType: 'EXTRACT_CLAIMS' as const, attemptNo: 1 },
      run,
      attempt: {},
    } as never);
    const request = llm.calls[llm.calls.length - 1];
    expect(request?.systemPrompt).toContain('重要安全规则');
    expect(request?.userPrompt).toContain('UNTRUSTED WEB CONTENT');
    expect(request?.userPrompt).toContain('postgresql.org/docs');
  });
});

describe('候选方向生成', () => {
  it('生成方向并按总分排序落库，引用事实正确关联', async () => {
    const { run } = await seedRunWithSources('方向生成测试');
    // 先注入两条事实
    const [c1, c2] = await db.db
      .insert(claims)
      .values([
        {
          runId: run.id,
          statement: '事实一',
          confidence: 0.9,
          primarySourceSupported: true,
        },
        {
          runId: run.id,
          statement: '事实二',
          confidence: 0.8,
          primarySourceSupported: false,
        },
      ])
      .returning();
    const docs = await db.db.select().from(sourceDocuments);
    await db.db.insert(claimSources).values([
      { claimId: c1?.id as string, sourceId: docs[0]?.id as string },
      { claimId: c2?.id as string, sourceId: docs[1]?.id as string },
    ]);

    llm.on(
      (request) => request.task === 'direction_generation',
      () =>
        JSON.stringify({
          directions: [
            {
              title: '低分方向',
              summary: '摘要',
              targetAudience: '开发者',
              keywords: ['数据库'],
              claimIndexes: [2],
              audienceMatch: 0.3,
              platformMatch: 0.3,
              novelty: 0.3,
              timeliness: 0.3,
              risk: 0.8,
            },
            {
              title: '高分方向',
              summary: '摘要',
              targetAudience: '开发者',
              keywords: ['性能'],
              claimIndexes: [1, 2],
              audienceMatch: 0.9,
              platformMatch: 0.9,
              novelty: 0.7,
              timeliness: 0.9,
              risk: 0.1,
            },
          ],
        }),
    );

    const output = await generateDirections({
      data: { runId: run.id, stepType: 'GENERATE_DIRECTIONS' as const, attemptNo: 1 },
      run,
      attempt: {},
    } as never);
    expect(output.outputRef).toBe('directions:2');

    const directions = await db.db.select().from(directionOptions);
    expect(directions).toHaveLength(2);
    const first = directions.find((row) => row.rank === 1);
    expect(first?.title).toBe('高分方向');
    expect(directions[0]?.totalScore).toBeGreaterThanOrEqual(
      directions[1]?.totalScore ?? 0,
    );

    // 排名第一的方向引用两条事实
    const links = await db.db.select().from(directionClaims);
    expect(links.filter((link) => link.directionId === first?.id)).toHaveLength(2);

    // 覆盖率已计算进因子
    const factors = first?.scoreFactors as { sourceCoverage: number };
    expect(factors.sourceCoverage).toBe(1);
  });

  it('引用不存在的事实时覆盖率为 0 且仍可落库', async () => {
    const { run } = await seedRunWithSources('无效引用测试');
    // 播种一条事实（方向将引用不存在的编号 5）
    const [seeded] = await db.db
      .insert(claims)
      .values({
        runId: run.id,
        statement: '已存在的事实',
        confidence: 0.9,
        primarySourceSupported: false,
      })
      .returning();
    void seeded;
    llm.on(
      (request) => request.task === 'direction_generation',
      () =>
        JSON.stringify({
          directions: [
            {
              title: '无引用方向',
              summary: '摘要',
              targetAudience: '用户',
              keywords: [],
              claimIndexes: [5],
              audienceMatch: 0.5,
              platformMatch: 0.5,
              novelty: 0.5,
              timeliness: 0.5,
              risk: 0.5,
            },
          ],
        }),
    );
    const output = await generateDirections({
      data: { runId: run.id, stepType: 'GENERATE_DIRECTIONS' as const, attemptNo: 1 },
      run,
      attempt: {},
    } as never);
    expect(output.outputRef).toBe('directions:1');
    const directions = await db.db.select().from(directionOptions);
    const factors = directions[0]?.scoreFactors as { sourceCoverage: number };
    expect(factors.sourceCoverage).toBe(0);
  });
});
