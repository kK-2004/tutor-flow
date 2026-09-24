import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  claimSources,
  claims,
  contentArtifacts,
  createRun,
  directionOptions,
  draftRevisions,
  requireRun,
  setRunSelectedDirection,
  sourceDocuments,
  upsertSetting,
} from '@tutor-flow/db';
import type { DbClient } from '@tutor-flow/db';
import type { StepHandler } from '@tutor-flow/workflow';
import { FakeLlmGateway } from '@tutor-flow/integrations';

import {
  createAdaptXiaohongshuHandler,
  createCreateDraftHandler,
  createGenerateCanonicalHandler,
  createModerateContentHandler,
} from '../../apps/worker/src/steps/content.js';
import { createInMemoryTextCache } from '../../apps/worker/src/research-text-cache.js';
import { createTestDb, setupTestDatabase, truncateAll } from '../db/setup';

/**
 * 内容步骤测试（5.1-5.4）：
 * 规范文章生成（来源引用+生成元数据）、衍生稿继承与无来源事实拒绝、
 * 审核门槛（隐私/媒体/AIGC）、草稿创建幂等。
 */

let db: DbClient;
let llm: FakeLlmGateway;
const textCache = createInMemoryTextCache();
let generateCanonical: StepHandler;
let adapt: StepHandler;
let moderate: StepHandler;
let createDraft: StepHandler;

beforeAll(async () => {
  await setupTestDatabase();
  db = createTestDb();
  llm = new FakeLlmGateway();
  generateCanonical = createGenerateCanonicalHandler({ db, llm, textCache });
  adapt = createAdaptXiaohongshuHandler({ db, llm, textCache });
  moderate = createModerateContentHandler({ db });
  createDraft = createCreateDraftHandler({ db });
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await truncateAll(db);
});

/** 建运行 + 方向 + 事实/来源 + 选向，返回运行行 */
async function seedResearchDone(topic = '内容链路测试') {
  const created = await createRun(db.db, {
    callerIdentity: 'operator:test',
    requestHash: `hash-${topic}`,
    topic: 'PostgreSQL 17 新特性解读',
    directionMode: 'manual',
    publishMode: 'review',
    platform: 'xiaohongshu',
    accountId: '00000000-0000-0000-0000-000000000001',
    triggerType: 'manual',
    triggeredBy: 'operator:test',
  });
  const run = await requireRun(db.db, created.runId);

  const [direction] = await db.db
    .insert(directionOptions)
    .values({
      runId: run.id,
      title: '升级指南方向',
      summary: '面向开发者的升级要点',
      targetAudience: '后端开发者',
      keywords: ['PostgreSQL'],
      scoreFactors: {
        sourceCoverage: 1,
        audienceMatch: 0.9,
        platformMatch: 0.8,
        novelty: 0.6,
        timeliness: 0.9,
        risk: 0.1,
      },
      totalScore: 88,
      rank: 1,
      scoringInputs: {},
    })
    .returning();
  await setRunSelectedDirection(db.db, run.id, direction?.id as string, run.version);
  // 重读运行行（selectedDirectionId 已回填）
  const freshRun = await requireRun(db.db, run.id);

  const [source] = await db.db
    .insert(sourceDocuments)
    .values({
      runId: run.id,
      canonicalUrl: 'https://postgresql.org/release',
      urlHash: 'h-docs',
      title: '官方发布说明',
      domain: 'postgresql.org',
      language: 'en',
      fetchStatus: 'FETCHED',
      isPrimary: true,
    })
    .returning();
  const [claim] = await db.db
    .insert(claims)
    .values({
      runId: run.id,
      statement: 'PostgreSQL 17 的 vacuum 性能提升约两倍',
      confidence: 0.95,
      primarySourceSupported: true,
      verifiedAt: new Date(),
      usedIn: [],
    })
    .returning();
  await db.db
    .insert(claimSources)
    .values({ claimId: claim?.id as string, sourceId: source?.id as string });
  await textCache.set(
    run.id,
    source?.id as string,
    'PostgreSQL 17 vacuum 性能相关正文。',
  );
  return { run: freshRun, claimId: claim?.id as string };
}

const canonicalScript = JSON.stringify({
  title: 'PostgreSQL 17 升级要点',
  body: 'PostgreSQL 17 的 vacuum 性能提升约两倍，本文给出升级要点。\n\n建议阅读官方发布说明。',
  usedClaims: [1],
});

describe('规范文章生成（5.1）', () => {
  it('生成 CANONICAL 制品并保存生成元数据与事实引用', async () => {
    const { run, claimId } = await seedResearchDone();
    llm.on(
      (request) => request.task === 'canonical_article',
      () => canonicalScript,
    );

    const output = await generateCanonical({
      data: { runId: run.id, stepType: 'GENERATE_CANONICAL' as const, attemptNo: 1 },
      run,
      attempt: {},
    } as never);
    expect(output.outputRef).toBeDefined();

    const artifacts = await db.db.select().from(contentArtifacts);
    expect(artifacts).toHaveLength(1);
    const artifact = artifacts[0];
    expect(artifact?.kind).toBe('CANONICAL');
    expect(artifact?.version).toBe(1);
    const usage = (artifact?.claimUsages as Array<{ claimId: string }>)[0];
    expect(usage?.claimId).toBe(claimId);
    const generation = artifact?.generation as {
      model: string;
      promptVersion: string;
      tokenUsage: { completionTokens: number };
    };
    expect(generation.model).toBe('fake-model-1');
    expect(generation.promptVersion).toBe('canonical-article@1');
    expect(generation.tokenUsage.completionTokens).toBeGreaterThan(0);
  });

  it('未引用任何事实时拒绝（CONTENT）', async () => {
    const { run } = await seedResearchDone();
    llm.on(
      (request) => request.task === 'canonical_article',
      () => JSON.stringify({ title: '无引用文章', body: '正文', usedClaims: [] }),
    );
    await expect(
      generateCanonical({
        data: { runId: run.id, stepType: 'GENERATE_CANONICAL' as const, attemptNo: 1 },
        run,
        attempt: {},
      } as never),
    ).rejects.toThrow(/未引用任何已核验事实/);
  });
});

const adaptScript = JSON.stringify({
  title: 'PG17 升级三点须知',
  body: 'PostgreSQL 17 的 vacuum 性能提升约两倍，升级前请阅读发布说明，平稳迁移。',
  tags: ['PostgreSQL', '数据库升级'],
  usedClaims: [1],
});

describe('小红书衍生稿适配（5.2）', () => {
  it('衍生稿继承事实且不执行第二次研究（LLM 只调用适配任务）', async () => {
    const { run } = await seedResearchDone();
    llm.on(
      (request) => request.task === 'canonical_article',
      () => canonicalScript,
    );
    llm.on(
      (request) => request.task === 'xhs_adapt',
      () => adaptScript,
    );

    await generateCanonical({
      data: { runId: run.id, stepType: 'GENERATE_CANONICAL' as const, attemptNo: 1 },
      run,
      attempt: {},
    } as never);
    await adapt({
      data: { runId: run.id, stepType: 'ADAPT_XIAOHONGSHU' as const, attemptNo: 1 },
      run,
      attempt: {},
    } as never);

    const artifacts = await db.db.select().from(contentArtifacts);
    const xhs = artifacts.find((artifact) => artifact.kind === 'XIAOHONGSHU');
    expect(xhs).toBeDefined();
    const usage = (xhs?.claimUsages as Array<{ claimId: string }>)[0];
    expect(usage?.claimId).toBeDefined();
    const adaptCalls = llm.calls.filter((request) => request.task === 'xhs_adapt');
    expect(adaptCalls).toHaveLength(1);
    expect(
      llm.calls.filter((request) => request.task === 'claim_extraction'),
    ).toHaveLength(0);
  });

  it('下一次生成使用刚保存的提示词，并记录实际提示词版本', async () => {
    const { run } = await seedResearchDone();
    llm.on(
      (request) => request.task === 'canonical_article',
      () => canonicalScript,
    );
    llm.on(
      (request) => request.task === 'xhs_adapt',
      () => adaptScript,
    );
    await generateCanonical({
      data: { runId: run.id, stepType: 'GENERATE_CANONICAL', attemptNo: 1 },
      run,
      attempt: {},
    } as never);
    const saved = await upsertSetting(db.db, {
      key: 'xiaohongshu_prompt',
      value: {
        systemPrompt:
          '为数据库管理员写可收藏的小红书笔记。严格依据已核验事实。标题点明收益，正文清晰具体，不编造任何事实。',
      },
      updatedBy: 'test',
    });
    await adapt({
      data: { runId: run.id, stepType: 'ADAPT_XIAOHONGSHU', attemptNo: 1 },
      run,
      attempt: {},
    } as never);
    const call = llm.calls.filter((request) => request.task === 'xhs_adapt').at(-1);
    expect(call?.systemPrompt).toContain('数据库管理员');
    expect(call?.systemPrompt).toContain('仅输出一个合法 JSON 对象');
    const artifact = (await db.db.select().from(contentArtifacts)).find(
      (item) => item.kind === 'XIAOHONGSHU',
    );
    expect((artifact?.generation as { promptVersion: string }).promptVersion).toMatch(
      new RegExp(`^xhs-adapt@${saved.version}-`),
    );
  });

  it('衍生稿未引用任何事实时拒绝进入发布校验（无来源事实门槛）', async () => {
    const { run } = await seedResearchDone();
    llm.on(
      (request) => request.task === 'canonical_article',
      () => canonicalScript,
    );
    llm.on(
      (request) => request.task === 'xhs_adapt',
      () =>
        JSON.stringify({
          title: '无事实衍生稿',
          body: '正文内容足够长但不引用任何事实。',
          tags: ['标签'],
          usedClaims: [],
        }),
    );
    await generateCanonical({
      data: { runId: run.id, stepType: 'GENERATE_CANONICAL' as const, attemptNo: 1 },
      run,
      attempt: {},
    } as never);
    await expect(
      adapt({
        data: { runId: run.id, stepType: 'ADAPT_XIAOHONGSHU' as const, attemptNo: 1 },
        run,
        attempt: {},
      } as never),
    ).rejects.toThrow(/未引用任何已核验事实/);
  });
});

/** 生成规范+衍生制品（合规正文，通过审核） */
async function seedValidXhs(
  run: Awaited<ReturnType<typeof seedResearchDone>>['run'],
  claimId: string,
  overrides: { body?: string; media?: string[]; aigc?: string } = {},
) {
  llm.on(
    (request) => request.task === 'canonical_article',
    () => canonicalScript,
  );
  llm.on(
    (request) => request.task === 'xhs_adapt',
    () => adaptScript,
  );
  await generateCanonical({
    data: { runId: run.id, stepType: 'GENERATE_CANONICAL' as const, attemptNo: 1 },
    run,
    attempt: {},
  } as never);
  await adapt({
    data: { runId: run.id, stepType: 'ADAPT_XIAOHONGSHU' as const, attemptNo: 1 },
    run,
    attempt: {},
  } as never);
  // 默认注入合规封面（PNG），除非用例显式覆盖
  const media = overrides.media ?? ['media/cover.png'];
  if (
    overrides.body !== undefined ||
    overrides.media !== undefined ||
    overrides.aigc !== undefined ||
    true
  ) {
    await db.db
      .update(contentArtifacts)
      .set({
        ...(overrides.body !== undefined ? { body: overrides.body } : {}),
        ...(overrides.media !== undefined
          ? { mediaObjectKeys: overrides.media }
          : { mediaObjectKeys: media }),
        ...(overrides.aigc !== undefined ? { aigcDisclosure: overrides.aigc } : {}),
      })
      .where(
        (await import('drizzle-orm')).and(
          (await import('drizzle-orm')).eq(contentArtifacts.runId, run.id),
          (await import('drizzle-orm')).eq(contentArtifacts.kind, 'XIAOHONGSHU'),
        ),
      );
  }
  void claimId;
}

describe('内容审核门槛（5.3）', () => {
  it('合规内容通过审核', async () => {
    const { run, claimId } = await seedResearchDone();
    await seedValidXhs(run, claimId);
    const output = await moderate({
      data: { runId: run.id, stepType: 'MODERATE_CONTENT' as const, attemptNo: 1 },
      run,
      attempt: {},
    } as never);
    expect(output.outputRef).toBeDefined();
  });

  it('正文含手机号（隐私）时审核失败', async () => {
    const { run, claimId } = await seedResearchDone();
    await seedValidXhs(run, claimId, {
      body: 'PostgreSQL 17 的 vacuum 性能提升约两倍，详情联系 13812345678 咨询，升级请阅读发布说明。',
    });
    await expect(
      moderate({
        data: { runId: run.id, stepType: 'MODERATE_CONTENT' as const, attemptNo: 1 },
        run,
        attempt: {},
      } as never),
    ).rejects.toThrow(/手机号/);
  });

  it('纯文字内容无需封面即可通过审核', async () => {
    const { run, claimId } = await seedResearchDone();
    await seedValidXhs(run, claimId, { media: [] });
    await expect(
      moderate({
        data: { runId: run.id, stepType: 'MODERATE_CONTENT' as const, attemptNo: 1 },
        run,
        attempt: {},
      } as never),
    ).resolves.toMatchObject({ outputRef: expect.any(String) });
  });
});

describe('草稿创建（5.4）', () => {
  it('创建修订一并幂等（重放不重复创建）', async () => {
    const { run, claimId } = await seedResearchDone();
    await seedValidXhs(run, claimId);
    const first = await createDraft({
      data: { runId: run.id, stepType: 'CREATE_DRAFT' as const, attemptNo: 1 },
      run,
      attempt: {},
    } as never);
    const second = await createDraft({
      data: { runId: run.id, stepType: 'CREATE_DRAFT' as const, attemptNo: 1 },
      run,
      attempt: {},
    } as never);
    expect(first.outputRef).toBe(second.outputRef);
    const drafts = await db.db.select().from(draftRevisions);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.revision).toBe(1);
    expect(drafts[0]?.status).toBe('PENDING_REVIEW');
  });
});
