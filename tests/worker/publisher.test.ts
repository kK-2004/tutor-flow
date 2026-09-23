import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  claimSources,
  claims,
  contentJobs,
  draftRevisions,
  platformAccounts,
  publishJobs,
  publishReceipts,
  requireRun,
  sourceDocuments,
  workflowRuns,
} from '@tutor-flow/db';
import type { DbClient } from '@tutor-flow/db';
import { eq } from 'drizzle-orm';

import {
  createMcpPublisherAdapter,
  FakePublisherAdapter,
  PublisherError,
  type PublisherAdapter,
} from '@tutor-flow/integrations';
import type { StepHandler } from '@tutor-flow/workflow';

import { createPublishLanes } from '../../apps/worker/src/publisher/lanes.js';
import { createPublishJobProcessor } from '../../apps/worker/src/publisher/processor.js';
import {
  createPublishHandler,
  createVerifyPublicationHandler,
  type PublishingHandlersDeps,
} from '../../apps/worker/src/steps/publishing.js';
import { createTestDb, setupTestDatabase, truncateAll } from '../db/setup';

/**
 * 发布集成测试（6.10）：
 * 回执优先短路、结果未知不盲发、瞬时重试安全、策略漂移防护、
 * 熔断器、账号串行、MCP 适配器映射。
 */

let db: DbClient;
let lanes = createPublishLanes({ jitterRandom: () => 0 });
let publish: StepHandler;
let verify: StepHandler;
let adapter: FakePublisherAdapter;

/** 可变依赖容器：beforeEach 重建后处理器通过 getter 取最新值 */
const holder: {
  db: DbClient;
  adapter: FakePublisherAdapter;
  lanes: ReturnType<typeof createPublishLanes>;
} = {} as never;

const RUN_ID = '10000000-0000-4000-8000-000000000001';
const CLAIM_ID = '20000000-0000-4000-8000-000000000001';
const SOURCE_ID = '30000000-0000-4000-8000-000000000001';
const ACCOUNT_ID = '00000000-0000-0000-0000-000000000001';

const secrets = {
  resolveSecret: async (ref: string) => {
    if (ref === 'env:XHS_ACCOUNT_TEST') {
      return 'cookie-string';
    }
    throw new Error(`未配置：${ref}`);
  },
};

const deps: PublishingHandlersDeps = {
  get db() {
    return holder.db;
  },
  get adapter() {
    return holder.adapter;
  },
  get lanes() {
    return holder.lanes;
  },
  secrets,
  jitterMs: 0,
};

beforeAll(async () => {
  await setupTestDatabase();
  db = createTestDb();
  holder.db = db;
  holder.adapter = adapter;
  holder.lanes = lanes;
  publish = createPublishHandler(deps);
  verify = createVerifyPublicationHandler(deps);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await truncateAll(db);
  lanes = createPublishLanes({ jitterRandom: () => 0 });
  adapter = new FakePublisherAdapter();
  holder.lanes = lanes;
  holder.adapter = adapter;
});

/** 播种：账号 + 运行 + 方向/事实/来源 + 合规草稿修订一 + QUEUED 发布任务 */
async function seedPublishableRun(topic = '发布测试') {
  await db.db
    .insert(platformAccounts)
    .values({
      id: ACCOUNT_ID,
      alias: '测试账号',
      platform: 'xiaohongshu',
      secretRef: 'env:XHS_ACCOUNT_TEST',
    })
    .onConflictDoNothing();
  const [job] = await db.db
    .insert(contentJobs)
    .values({
      topic,
      directionMode: 'manual',
      publishMode: 'review',
      platform: 'xiaohongshu',
      accountId: ACCOUNT_ID,
      triggerType: 'manual',
      triggeredBy: 'operator:test',
    })
    .returning();
  await db.db
    .insert(workflowRuns)
    .values({ id: RUN_ID, contentJobId: job?.id as string });
  const run = await requireRun(db.db, RUN_ID);
  await db.db.insert(sourceDocuments).values({
    id: SOURCE_ID,
    runId: RUN_ID,
    canonicalUrl: 'https://postgresql.org/release',
    urlHash: 'h-docs',
    title: '官方说明',
    domain: 'postgresql.org',
    language: 'en',
    fetchStatus: 'FETCHED',
    isPrimary: true,
  });
  await db.db.insert(claims).values({
    id: CLAIM_ID,
    runId: RUN_ID,
    statement: '事实',
    confidence: 0.9,
    primarySourceSupported: true,
  });
  await db.db.insert(claimSources).values({ claimId: CLAIM_ID, sourceId: SOURCE_ID });
  await db.db.insert(draftRevisions).values({
    runId: RUN_ID,
    revision: 1,
    status: 'PENDING_REVIEW',
    title: 'PG17 升级须知',
    body: VALID_BODY,
    tags: ['PostgreSQL'],
    mediaObjectKeys: ['media/cover.png'],
    claimUsages: [{ claimId: CLAIM_ID, locator: 'body' }],
    createdBy: 'system:test',
  });
  return run;
}

const VALID_BODY =
  'PostgreSQL 17 的 vacuum 性能提升约两倍，升级前请阅读发布说明，平稳迁移。';

/** 播种 QUEUED 发布任务（批准动作的结果形态） */
async function seedPublishJob() {
  const [job] = await db.db
    .insert(publishJobs)
    .values({
      runId: RUN_ID,
      draftRevisionId: '40000000-0000-4000-8000-000000000001',
      accountId: ACCOUNT_ID,
      status: 'QUEUED',
      idempotencyKey: 'publish-key-test',
      approvedBy: 'operator:test',
    })
    .returning();
  return job;
}

// draft revision id 常量（seedPublishableRun 中未显式指定）
const DRAFT_ID = '40000000-0000-4000-8000-000000000001';

/** 修正：seedPublishableRun 显式指定草稿 id（供发布任务外键） */
async function seedPublishableRunWithDraftId(topic: string) {
  const run = await seedPublishableRun(topic);
  // 补草稿 id：删除后重建（简化处理）
  await db.db.delete(draftRevisions);
  await db.db.insert(draftRevisions).values({
    id: DRAFT_ID,
    runId: run.id,
    revision: 1,
    status: 'PENDING_REVIEW',
    title: 'PG17 升级须知',
    body: VALID_BODY,
    tags: ['PostgreSQL'],
    mediaObjectKeys: ['media/cover.png'],
    claimUsages: [{ claimId: CLAIM_ID, locator: 'body' }],
    createdBy: 'system:test',
  });
  return run;
}

describe('effectively-once 发布（6.7）', () => {
  it('发布成功：回执先落库，任务转 SUCCEEDED', async () => {
    await seedPublishableRunWithDraftId('发布成功测试');
    await seedPublishJob();

    const output = await publish({
      data: { runId: RUN_ID, stepType: 'PUBLISH' as const, attemptNo: 1 },
      run: await requireRun(db.db, RUN_ID),
      attempt: {},
    } as never);

    expect(output.outputRef).toBe(DRAFT_ID);
    const jobs = await db.db.select().from(publishJobs);
    expect(jobs[0]?.status).toBe('SUCCEEDED');
    expect(adapter.publishedCalls).toHaveLength(1);
  });

  it('回执已存在时短路：不再调用发布（重复投递安全）', async () => {
    await seedPublishableRunWithDraftId('回执短路测试');
    const job = await seedPublishJob();
    // 第一次发布成功
    await publish({
      data: { runId: RUN_ID, stepType: 'PUBLISH' as const, attemptNo: 1 },
      run: await requireRun(db.db, RUN_ID),
      attempt: {},
    } as never);
    expect(adapter.publishedCalls).toHaveLength(1);

    // 重复投递（状态重置为 QUEUED 模拟）
    await db.db
      .update(publishJobs)
      .set({ status: 'QUEUED' })
      .where(eqJob(job?.id as string));
    await publish({
      data: { runId: RUN_ID, stepType: 'PUBLISH' as const, attemptNo: 2 },
      run: await requireRun(db.db, RUN_ID),
      attempt: {},
    } as never);
    // 发布调用次数不变：回执短路生效
    expect(adapter.publishedCalls).toHaveLength(1);
  });

  it('发布响应丢失：任务转 UNKNOWN_OUTCOME，不自动重试', async () => {
    await seedPublishableRunWithDraftId('响应丢失测试');
    await seedPublishJob();
    adapter.mode = 'lost_response';

    await expect(
      publish({
        data: { runId: RUN_ID, stepType: 'PUBLISH' as const, attemptNo: 1 },
        run: await requireRun(db.db, RUN_ID),
        attempt: {},
      } as never),
    ).rejects.toThrow(PublisherError);

    const jobs = await db.db.select().from(publishJobs);
    expect(jobs[0]?.status).toBe('UNKNOWN_OUTCOME');
    // 副作用疑似发生过一次；重试前必须核验
    expect(adapter.publishedCalls).toHaveLength(1);
  });

  it('策略漂移：批准后策略更新会阻止发布并转人工', async () => {
    await seedPublishableRunWithDraftId('策略漂移测试');
    await seedPublishJob();
    // 内容被改得违规（注入手机号），模拟批准后内容/策略变化
    await db.db
      .update(draftRevisions)
      .set({ body: 'PostgreSQL 17 发布，联系 13812345678 了解详情，长度充足。' })
      .where(eqDraft());

    await expect(
      publish({
        data: { runId: RUN_ID, stepType: 'PUBLISH' as const, attemptNo: 1 },
        run: await requireRun(db.db, RUN_ID),
        attempt: {},
      } as never),
    ).rejects.toThrow(/策略漂移/);
    const jobs = await db.db.select().from(publishJobs);
    expect(jobs[0]?.status).toBe('NEEDS_HUMAN');
    expect(adapter.publishedCalls).toHaveLength(0);
  });
});

describe('核验与人工处置（6.8）', () => {
  it('发布成功后核验 VERIFIED', async () => {
    await seedPublishableRunWithDraftId('核验成功测试');
    await seedPublishJob();
    await publish({
      data: { runId: RUN_ID, stepType: 'PUBLISH' as const, attemptNo: 1 },
      run: await requireRun(db.db, RUN_ID),
      attempt: {},
    } as never);
    const output = await verify({
      data: { runId: RUN_ID, stepType: 'VERIFY_PUBLICATION' as const, attemptNo: 1 },
      run: await requireRun(db.db, RUN_ID),
      attempt: {},
    } as never);
    expect(output.outputRef).toContain('post-');
  });
});

describe('发布处理器重试（6.9）', () => {
  it('瞬时错误只进行有界重试，成功后不产生重复副作用', async () => {
    await seedPublishableRunWithDraftId('瞬时重试测试');
    const job = await seedPublishJob();
    const fake = new FakePublisherAdapter();
    let failOnce = true;
    const transientAdapter: PublisherAdapter = {
      checkAuth: (account) => fake.checkAuth(account),
      validate: (account, content) => fake.validate(account, content),
      preview: (account, content) => fake.preview(account, content),
      queryStatus: (account, postId) => fake.queryStatus(account, postId),
      async publish(account, content) {
        if (failOnce) {
          failOnce = false;
          throw new PublisherError('TRANSIENT', '模拟网络抖动');
        }
        return fake.publish(account, content);
      },
    };
    const process = createPublishJobProcessor({
      db,
      adapter: transientAdapter,
      secrets,
      jitterMs: 0,
      maxRetries: 3,
    });
    const bullJob = { data: { publishJobId: job?.id as string } };

    await process(bullJob as never);
    let current = await db.db.select().from(publishJobs);
    expect(current[0]?.status).toBe('FAILED');
    expect(current[0]?.attempts).toBe(1);

    await process(bullJob as never);
    current = await db.db.select().from(publishJobs);
    expect(current[0]?.status).toBe('SUCCEEDED');
    expect(fake.publishedCalls).toHaveLength(1);
  });
});

describe('账号通道（6.6）', () => {
  it('同一账号串行执行（完成顺序与提交顺序一致）', async () => {
    const lanesLocal = createPublishLanes({ jitterRandom: () => 0 });
    const order: string[] = [];
    const makeTask = (name: string, delayMs: number) => async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
      order.push(name);
    };
    await Promise.all([
      lanesLocal.run(
        'acct-1',
        { concurrency: 1, tokensPerWindow: 10, windowMs: 60000, jitterMs: 0 },
        makeTask('first', 30),
      ),
      lanesLocal.run(
        'acct-1',
        { concurrency: 1, tokensPerWindow: 10, windowMs: 60000, jitterMs: 0 },
        makeTask('second', 5),
      ),
    ]);
    expect(order).toEqual(['first', 'second']);
  });

  it('选择器连续失效三次触发熔断', async () => {
    const lanesLocal = createPublishLanes({ jitterRandom: () => 0 });
    lanesLocal.recordSelectorFailure(ACCOUNT_ID);
    lanesLocal.recordSelectorFailure(ACCOUNT_ID);
    expect(lanesLocal.isBreakerOpen(ACCOUNT_ID)).toBe(false);
    lanesLocal.recordSelectorFailure(ACCOUNT_ID);
    expect(lanesLocal.isBreakerOpen(ACCOUNT_ID)).toBe(true);
    lanesLocal.resetBreaker(ACCOUNT_ID);
    expect(lanesLocal.isBreakerOpen(ACCOUNT_ID)).toBe(false);
  });
});

describe('MCP 适配器映射（6.4）', () => {
  it('绑定账号不匹配时拒绝发布，不调用上游 MCP', async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: '内容发布成功: {Status:发布完成}' }],
    }));
    const adapter = createMcpPublisherAdapter({ boundAccountId: ACCOUNT_ID, callTool });
    const account = { accountId: 'another-account', alias: '其他账号', secretValue: '' };
    const content = {
      title: '标题',
      body: '正文',
      tags: [],
      mediaObjectKeys: ['https://cdn.example/cover.png'],
      aigcDisclosed: true,
    };

    await expect(adapter.validate(account, content)).resolves.toMatchObject({
      valid: false,
    });
    await expect(adapter.publish(account, content)).rejects.toMatchObject({
      code: 'REJECTED',
    });
    expect(callTool).not.toHaveBeenCalled();
  });

  it('发布前按 fileId 换取 CDN URL，不把文件元数据传给 MCP', async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const resolved: number[] = [];
    const adapter = createMcpPublisherAdapter({
      resolveMediaUrl: async (fileId) => {
        resolved.push(fileId);
        return `https://cdn.example/${fileId}.png`;
      },
      callTool: async (tool, args) => {
        calls.push({ tool, args });
        return { content: [{ type: 'text', text: '内容发布成功: {Status:发布完成}' }] };
      },
    });
    await expect(
      adapter.publish(
        { accountId: 'a', alias: 'a', secretValue: 'cookie' },
        {
          title: '标题',
          body: '正文',
          tags: [],
          mediaObjectKeys: [{ fileId: 42, name: '封面.png', contentType: 'image/png' }],
          aigcDisclosed: true,
        },
      ),
    ).rejects.toMatchObject({ code: 'NEEDS_HUMAN', sideEffectSuspected: true });
    expect(resolved).toEqual([42]);
    expect(calls[0]?.tool).toBe('publish_content');
    expect(calls[0]?.args['images']).toEqual(['https://cdn.example/42.png']);
    expect(calls[0]?.args).not.toHaveProperty('cookie');
  });

  it('按容器登录态检查授权，发布结果无 ID 时不伪造回执', async () => {
    const adapterMcp = createMcpPublisherAdapter({
      callTool: async (tool) => {
        if (tool === 'check_login_status') {
          return { content: [{ type: 'text', text: '✅ 已登录\n用户名: 测试账号' }] };
        }
        return { content: [{ type: 'text', text: '内容发布成功: {Status:发布完成}' }] };
      },
    });
    await expect(
      adapterMcp.checkAuth({ accountId: 'a', alias: 'a', secretValue: '' }),
    ).resolves.toMatchObject({ healthy: 'HEALTHY' });
    await expect(
      adapterMcp.publish(
        { accountId: 'a', alias: 'a', secretValue: 'cookie' },
        {
          title: '标题',
          body: '正文',
          tags: [],
          mediaObjectKeys: ['https://cdn.example/cover.png'],
          aigcDisclosed: true,
        },
      ),
    ).rejects.toMatchObject({ code: 'NEEDS_HUMAN' });

    const badAdapter = createMcpPublisherAdapter({
      callTool: async () => ({
        isError: true,
        content: [{ type: 'text', text: '失败' }],
      }),
    });
    await expect(
      badAdapter.publish(
        { accountId: 'a', alias: 'a', secretValue: 'cookie' },
        {
          title: '标题',
          body: '正文',
          tags: [],
          mediaObjectKeys: ['https://cdn.example/cover.png'],
          aigcDisclosed: true,
        },
      ),
    ).rejects.toMatchObject({ code: 'NEEDS_HUMAN', sideEffectSuspected: true });
  });

  it('上游仅返回发布成功文本时任务转人工且不写虚假回执', async () => {
    await seedPublishableRunWithDraftId('上游发布文本测试');
    await seedPublishJob();
    await db.db
      .update(draftRevisions)
      .set({
        mediaObjectKeys: [{ fileId: 42, name: '封面.png', contentType: 'image/png' }],
      })
      .where(eqDraft());
    holder.adapter = createMcpPublisherAdapter({
      resolveMediaUrl: async () => 'https://cdn.example/cover.png',
      callTool: async () => ({
        content: [{ type: 'text', text: '内容发布成功: {Status:发布完成}' }],
      }),
    }) as never;

    await expect(
      publish({
        data: { runId: RUN_ID, stepType: 'PUBLISH' as const, attemptNo: 1 },
        run: await requireRun(db.db, RUN_ID),
        attempt: {},
      } as never),
    ).rejects.toMatchObject({ code: 'NEEDS_HUMAN' });

    const jobs = await db.db.select().from(publishJobs);
    const receipts = await db.db.select().from(publishReceipts);
    expect(jobs[0]?.status).toBe('NEEDS_HUMAN');
    expect(receipts).toHaveLength(0);
  });
});

// ---- 辅助 ----
function eqJob(id: string) {
  return eq(publishJobs.id, id);
}

function eqDraft() {
  return eq(draftRevisions.runId, RUN_ID);
}
