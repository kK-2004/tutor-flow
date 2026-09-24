import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  claimSources,
  claims,
  contentJobs,
  draftRevisions,
  platformAccounts,
  publishJobs,
  sourceDocuments,
  workflowRuns,
} from '@tutor-flow/db';
import type { DbClient } from '@tutor-flow/db';
import type { ApiEnv } from '@tutor-flow/config/server';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../apps/api/src/app.js';
import {
  createTestDb,
  setupTestDatabase,
  truncateAll,
  TEST_DATABASE_URL,
} from '../db/setup';

/**
 * 草稿 API 集成测试（5.5-5.7）：
 * 列表/详情、清洗 + 乐观锁 PATCH、预览、批准幂等与 422 拒绝。
 */

const OPERATOR_TOKEN = 'oper-token-test';

let db: DbClient;
let app: FastifyInstance;

function api() {
  return {
    get: (url: string) =>
      app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      }),
    patch: (url: string, payload: object) =>
      app.inject({
        method: 'PATCH',
        url,
        headers: {
          authorization: `Bearer ${OPERATOR_TOKEN}`,
          'content-type': 'application/json',
        },
        payload,
      }),
    post: (url: string, payload: object) =>
      app.inject({
        method: 'POST',
        url,
        headers: {
          authorization: `Bearer ${OPERATOR_TOKEN}`,
          'content-type': 'application/json',
        },
        payload,
      }),
    delete: (url: string) =>
      app.inject({
        method: 'DELETE',
        url,
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      }),
  };
}

const RUN_ID = '10000000-0000-4000-8000-000000000001';
const ACCOUNT_ID = '00000000-0000-0000-0000-000000000001';
const CLAIM_ID = '20000000-0000-4000-8000-000000000001';
const SOURCE_ID = '30000000-0000-4000-8000-000000000001';

const VALID_BODY =
  'PostgreSQL 17 的 vacuum 性能提升约两倍，升级前请阅读发布说明，平稳迁移。';

beforeAll(async () => {
  await setupTestDatabase();
  db = createTestDb();
  const env: ApiEnv = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    API_HOST: '127.0.0.1',
    API_PORT: 4000,
    SQLITE_PATH: TEST_DATABASE_URL,
    REDIS_URL: 'redis://127.0.0.1:6379',
    OPERATOR_TOKEN,
  };
  const handle = await buildApp({ db, env });
  app = handle.app;
});

afterAll(async () => {
  try {
    await app.close();
  } catch {
    // 已关闭
  }
  await db.close();
});

/** 播种：运行 + 合规草稿修订一（含事实/来源绑定与封面媒体） */
async function seedDraft(body = VALID_BODY, media: string[] = ['media/cover.png']) {
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
      topic: '草稿 API 测试',
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
    .values({ id: RUN_ID, contentJobId: job?.id as string, status: 'NEEDS_REVIEW' });
  const [source] = await db.db
    .insert(sourceDocuments)
    .values({
      id: SOURCE_ID,
      runId: RUN_ID,
      canonicalUrl: 'https://postgresql.org/release',
      urlHash: 'h-docs',
      title: '官方说明',
      domain: 'postgresql.org',
      language: 'en',
      fetchStatus: 'FETCHED',
      isPrimary: true,
    })
    .returning();
  await db.db.insert(claims).values({
    id: CLAIM_ID,
    runId: RUN_ID,
    statement: 'PostgreSQL 17 的 vacuum 性能提升约两倍',
    confidence: 0.9,
    primarySourceSupported: true,
  });
  await db.db
    .insert(claimSources)
    .values({ claimId: CLAIM_ID, sourceId: source?.id as string });
  await db.db.insert(draftRevisions).values({
    id: '40000000-0000-4000-8000-000000000001',
    runId: RUN_ID,
    revision: 1,
    status: 'PENDING_REVIEW',
    title: 'PG17 升级须知',
    body,
    tags: ['PostgreSQL'],
    mediaObjectKeys: media,
    claimUsages: [{ claimId: CLAIM_ID, locator: 'body' }],
    createdBy: 'system:test',
  });
}

beforeEach(async () => {
  await truncateAll(db);
});

describe('草稿列表与详情', () => {
  it('列表返回待审核草稿', async () => {
    await seedDraft();
    const response = await api().get('/api/v1/drafts');
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      items: Array<{ runId: string; title: string }>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.items[0]?.runId).toBe(RUN_ID);
  });

  it('详情返回最新修订内容；未知运行 404', async () => {
    await seedDraft();
    const detail = await api().get(`/api/v1/drafts/${RUN_ID}`);
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as { title: string; body: string; topic: string };
    expect(body.title).toBe('PG17 升级须知');
    expect(body.topic).toBe('草稿 API 测试');

    const missing = await api().get(
      '/api/v1/drafts/10000000-0000-4000-8000-00000000dead',
    );
    expect(missing.statusCode).toBe(404);
  });
});

describe('草稿删除', () => {
  it('空 JSON 请求返回 400 且不删除草稿', async () => {
    await seedDraft();
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/drafts/${RUN_ID}`,
      headers: {
        authorization: `Bearer ${OPERATOR_TOKEN}`,
        'content-type': 'application/json',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'FST_ERR_CTP_EMPTY_JSON_BODY' });
    expect((await api().get(`/api/v1/drafts/${RUN_ID}`)).statusCode).toBe(200);
  });

  it('无效 JSON 请求返回 400', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/drafts/${RUN_ID}`,
      headers: {
        authorization: `Bearer ${OPERATOR_TOKEN}`,
        'content-type': 'application/json',
      },
      payload: '{',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'FST_ERR_CTP_INVALID_JSON_BODY' });
  });

  it('从草稿箱移除草稿并取消待审核工作流，历史修订保留', async () => {
    await seedDraft();
    const deleted = await api().delete(`/api/v1/drafts/${RUN_ID}`);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ runId: RUN_ID, deleted: true });
    expect((await api().get(`/api/v1/drafts/${RUN_ID}`)).statusCode).toBe(404);
    expect(
      (await api().get('/api/v1/drafts?status=PENDING_REVIEW')).json(),
    ).toMatchObject({
      total: 0,
      items: [],
    });
    const [revision] = await db.db.select().from(draftRevisions);
    const [run] = await db.db.select().from(workflowRuns);
    expect(revision?.deletedAt).toBeInstanceOf(Date);
    expect(run?.status).toBe('CANCELLED');
  });
});

describe('草稿保存（清洗 + 乐观锁）', () => {
  it('合法保存产生修订二并返回版本', async () => {
    await seedDraft();
    const response = await api().patch(`/api/v1/drafts/${RUN_ID}`, {
      expectedRevision: 1,
      title: '更新后的标题',
      body: VALID_BODY,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { revision: number };
    expect(body.revision).toBe(2);
  });

  it('内容中心图片按 fileId 和权威 MIME 保存并参与预览校验', async () => {
    await seedDraft();
    const media = { fileId: 42, name: '封面.png', contentType: 'image/png' };
    const saved = await api().patch(`/api/v1/drafts/${RUN_ID}`, {
      expectedRevision: 1,
      mediaObjectKeys: [media],
    });
    expect(saved.statusCode).toBe(200);
    const detail = await api().get(`/api/v1/drafts/${RUN_ID}`);
    expect(detail.json().mediaObjectKeys).toEqual([media]);
    const preview = await api().get(`/api/v1/drafts/${RUN_ID}/preview`);
    expect(preview.json().blocking).toBe(false);
    const invalid = await api().patch(`/api/v1/drafts/${RUN_ID}`, {
      expectedRevision: 2,
      mediaObjectKeys: [{ fileId: 42, name: 'bad.svg', contentType: 'image/svg+xml' }],
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('过期版本返回 409 且不覆盖较新修订', async () => {
    await seedDraft();
    await api().patch(`/api/v1/drafts/${RUN_ID}`, {
      expectedRevision: 1,
      title: '第一版修改',
    });
    const stale = await api().patch(`/api/v1/drafts/${RUN_ID}`, {
      expectedRevision: 1,
      title: '并发旧稿',
    });
    expect(stale.statusCode).toBe(409);
    const drafts = await db.db.select().from(draftRevisions);
    expect(drafts).toHaveLength(2);
  });

  it('正文中的脚本与事件处理器在保存前被清洗', async () => {
    await seedDraft();
    const dirty = `${VALID_BODY}<script>alert(1)</script><img src="x" onerror="alert(1)">`;
    const response = await api().patch(`/api/v1/drafts/${RUN_ID}`, {
      expectedRevision: 1,
      body: dirty,
    });
    expect(response.statusCode).toBe(200);
    const draft = (await db.db.select().from(draftRevisions)).find(
      (row) => row.revision === 2,
    );
    expect(draft?.body).not.toContain('<script>');
    expect(draft?.body).not.toContain('onerror');
    expect(draft?.body).toContain(VALID_BODY);
  });
});

describe('生效内容预览', () => {
  it('返回字符计数、策略版本、媒体顺序与校验结果', async () => {
    await seedDraft();
    const response = await api().get(`/api/v1/drafts/${RUN_ID}/preview`);
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      policyVersion: string;
      titleLength: number;
      bodyLength: number;
      mediaObjectKeys: string[];
      blocking: boolean;
      issues: unknown[];
    };
    expect(body.policyVersion).toBe('xhs-policy@2026.09');
    expect(body.titleLength).toBe('PG17 升级须知'.length);
    expect(body.mediaObjectKeys[0]).toBe('media/cover.png');
    expect(body.blocking).toBe(false);
    expect(body.issues).toHaveLength(0);
  });
});

describe('草稿批准（事务性幂等）', () => {
  it('审核草稿后完成内容任务，重复审核保持幂等且不创建发布任务', async () => {
    await seedDraft();
    const first = await api().post(`/api/v1/drafts/${RUN_ID}/approve`, {
      expectedRevision: 1,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      runId: RUN_ID,
      revision: 1,
      status: 'APPROVED',
    });
    const second = await api().post(`/api/v1/drafts/${RUN_ID}/approve`, {
      expectedRevision: 1,
    });
    expect(second.statusCode).toBe(200);
    expect((await db.db.select().from(workflowRuns))[0]?.status).toBe('SUCCEEDED');
    expect(await db.db.select().from(publishJobs)).toHaveLength(0);
  });

  it('最新修订校验失败返回 422 且不创建发布任务', async () => {
    await seedDraft('包含手机号 13812345678 的违规正文，长度充足。');
    const response = await api().post(`/api/v1/drafts/${RUN_ID}/approve`, {
      expectedRevision: 1,
    });
    expect(response.statusCode).toBe(422);
    const body = response.json() as { issues: Array<{ field: string }> };
    expect(body.issues.some((issue) => issue.field === 'privacy')).toBe(true);
    const jobs = await db.db.select().from(publishJobs);
    expect(jobs).toHaveLength(0);
  });
});
