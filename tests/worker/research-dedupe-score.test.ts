import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createRun,
  duplicateClusters,
  requireRun,
  sourceDocuments,
} from '@tutor-flow/db';
import type { DbClient } from '@tutor-flow/db';
import type { StepHandler } from '@tutor-flow/workflow';
import type { VectorService } from '@tutor-flow/integrations';

import {
  createDedupeSourcesHandler,
  createScoreSourcesHandler,
  extractKeywords,
  timelinessFactor,
} from '../../apps/worker/src/steps/research.js';
import { createInMemoryTextCache } from '../../apps/worker/src/research-text-cache.js';
import { createTestDb, setupTestDatabase, truncateAll } from '../db/setup';

/**
 * 去重聚类与来源评分测试：
 * 指纹聚类、角色标记、语义合并（桩向量）、评分因子与总分落库。
 */

let db: DbClient;
let dedupe: StepHandler;
let score: StepHandler;
const textCache = createInMemoryTextCache();

/** 桩向量服务：按文本前缀返回预置向量（确定性） */
const stubVector: VectorService = {
  async embed(text: string): Promise<number[]> {
    if (text.startsWith('VEC_A')) {
      return [1, 0];
    }
    if (text.startsWith('VEC_A_NEAR')) {
      return [0.999, 0.045];
    }
    return [0, 1];
  },
  similarity(a: number[], b: number[]): number {
    return (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0);
  },
};

beforeAll(async () => {
  await setupTestDatabase();
  db = createTestDb();
  dedupe = createDedupeSourcesHandler({ db, vector: stubVector, textCache });
  score = createScoreSourcesHandler({ db, textCache });
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await truncateAll(db);
});

/** 建运行 */
async function seedRun(topic: string) {
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

describe('去重聚类', () => {
  it('相同内容哈希聚为一簇：规范+转载角色，记录全保留', async () => {
    const run = await seedRun('指纹聚类测试');
    await db.db
      .insert(sourceDocuments)
      .values([
        {
          runId: run.id,
          canonicalUrl: 'https://original.com/post',
          urlHash: 'h-original',
          title: '原始出处',
          domain: 'original.com',
          language: 'zh',
          fetchStatus: 'FETCHED',
          contentHash: 'hash-same',
        },
        {
          runId: run.id,
          canonicalUrl: 'https://repost.com/copy',
          urlHash: 'h-repost',
          title: '中文转载',
          domain: 'repost.com',
          language: 'zh',
          fetchStatus: 'FETCHED',
          contentHash: 'hash-same',
        },
        {
          runId: run.id,
          canonicalUrl: 'https://other.com/unique',
          urlHash: 'h-unique',
          title: '无关内容',
          domain: 'other.com',
          language: 'zh',
          fetchStatus: 'FETCHED',
          contentHash: 'hash-unique',
        },
      ])
      .returning();

    const output = await dedupe({
      data: { runId: run.id, stepType: 'DEDUPE_SOURCES' as const, attemptNo: 1 },
      run,
      attempt: {},
    } as never);
    expect(output.outputRef).toBe('clusters:1');

    const clusters = await db.db.select().from(duplicateClusters);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.method).toBe('TEXT_FINGERPRINT');

    // 重新查询（inserted 是更新前的旧快照）
    const rows = await db.db.select().from(sourceDocuments);
    const original = rows.find((row) => row.urlHash === 'h-original');
    const repost = rows.find((row) => row.urlHash === 'h-repost');
    const unique = rows.find((row) => row.urlHash === 'h-unique');
    expect(original?.clusterRole).toBe('CANONICAL');
    expect(repost?.clusterRole).toBe('DUPLICATE');
    expect(repost?.clusterId).toBe(original?.clusterId);
    expect(unique?.clusterId).toBeNull();
    expect(unique?.clusterRole).toBeNull();
  });

  it('语义高相似的独立来源合并（桩向量）', async () => {
    const run = await seedRun('语义聚类测试');
    const inserted = await db.db
      .insert(sourceDocuments)
      .values([
        {
          runId: run.id,
          canonicalUrl: 'https://a.com/x',
          urlHash: 'h-a',
          title: 'A',
          domain: 'a.com',
          language: 'zh',
          fetchStatus: 'FETCHED',
          contentHash: 'hash-x1',
        },
        {
          runId: run.id,
          canonicalUrl: 'https://b.com/y',
          urlHash: 'h-b',
          title: 'B',
          domain: 'b.com',
          language: 'zh',
          fetchStatus: 'FETCHED',
          contentHash: 'hash-x2',
        },
      ])
      .returning();

    // 正文写入缓存（决定向量脚本）
    for (const row of inserted) {
      const prefix = row.urlHash === 'h-a' ? 'VEC_A ' : 'VEC_A_NEAR ';
      await textCache.set(run.id, row.id, `${prefix}正文内容`);
    }

    const output = await dedupe({
      data: { runId: run.id, stepType: 'DEDUPE_SOURCES' as const, attemptNo: 1 },
      run,
      attempt: {},
    } as never);
    expect(output.outputRef).toBe('clusters:1');

    const clusters = await db.db.select().from(duplicateClusters);
    expect(clusters[0]?.method).toBe('SEMANTIC');
    expect(clusters[0]?.similarity).toBeGreaterThanOrEqual(0.9);
  });
});

describe('来源评分', () => {
  it('评分因子与总分按权重落库', async () => {
    const run = await seedRun('PostgreSQL 17 评分测试');
    const inserted = await db.db
      .insert(sourceDocuments)
      .values([
        {
          runId: run.id,
          canonicalUrl: 'https://postgresql.org/docs',
          urlHash: 'h-docs',
          title: 'PostgreSQL 17 文档',
          domain: 'postgresql.org',
          language: 'en',
          fetchStatus: 'FETCHED',
          sourceType: 'OFFICIAL_DOCS',
          isPrimary: true,
          publishedAt: new Date().toISOString(),
          contentHash: 'hash-1',
        },
        {
          runId: run.id,
          canonicalUrl: 'https://news.com/repost',
          urlHash: 'h-news',
          title: '无关新闻',
          domain: 'news.com',
          language: 'zh',
          fetchStatus: 'FETCHED',
          sourceType: 'NEWS',
          publishedAt: '2020-01-01T00:00:00Z',
          contentHash: 'hash-2',
        },
      ])
      .returning();
    for (const row of inserted) {
      await textCache.set(run.id, row.id, 'PostgreSQL 17 的正文内容包含关键词');
    }

    const output = await score({
      data: { runId: run.id, stepType: 'SCORE_SOURCES' as const, attemptNo: 1 },
      run,
      attempt: {},
    } as never);
    expect(output.outputRef).toBe('scored:2');

    const rows = await db.db.select().from(sourceDocuments);
    const docs = rows.find((row) => row.urlHash === 'h-docs');
    const news = rows.find((row) => row.urlHash === 'h-news');
    const docsFactors = docs?.scoreFactors as Record<string, number>;
    const newsFactors = news?.scoreFactors as Record<string, number>;

    // 官方文档权威性高于普通新闻
    expect(docsFactors['authority']).toBeGreaterThan(newsFactors['authority']);
    // 官方文档相关性命中主题关键词
    expect(docsFactors['relevance']).toBeGreaterThan(0);
    // 旧新闻时效性低
    expect(newsFactors['timeliness']).toBeLessThan(0.5);
    // 官方文档总分更高（权威非中文原始来源优先于普通来源）
    expect(docs?.totalScore ?? 0).toBeGreaterThan(news?.totalScore ?? 0);
  });
});

describe('评分辅助函数', () => {
  it('关键词提取覆盖拉丁词与 CJK 二元组', () => {
    const keywords = extractKeywords('PostgreSQL 17 发布');
    expect(keywords).toContain('postgresql');
    expect(keywords).toContain('发布');
  });

  it('时效性因子随年龄衰减', () => {
    expect(timelinessFactor(new Date().toISOString())).toBe(1);
    expect(timelinessFactor('2020-01-01T00:00:00Z')).toBeLessThan(0.5);
    expect(timelinessFactor('2 days ago')).toBe(1);
    expect(timelinessFactor(null)).toBe(0.3);
  });
});
