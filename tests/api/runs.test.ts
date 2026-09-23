import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { platformAccounts } from '@tutor-flow/db';
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
 * 运行任务 API 集成测试：认证、幂等触发、校验、列表详情、取消。
 * 依赖本地 SQLite（测试专用临时库）与本地 Redis（已部署实例）。
 */

const OPERATOR_TOKEN = 'oper-token-test';
const SCHEDULER_TOKEN = 'sched-token-test';

let db: DbClient;
let app: FastifyInstance;

/** 注入辅助：自动带认证头 */
function api() {
  return {
    get: (url: string, token: string = OPERATOR_TOKEN) =>
      app.inject({
        method: 'GET',
        url,
        headers: token === '' ? {} : { authorization: `Bearer ${token}` },
      }),
    post: (
      url: string,
      payload?: object,
      token: string = OPERATOR_TOKEN,
      extraHeaders: Record<string, string> = {},
    ) =>
      app.inject({
        method: 'POST',
        url,
        headers: {
          ...(token === '' ? {} : { authorization: `Bearer ${token}` }),
          'content-type': 'application/json',
          ...extraHeaders,
        },
        payload,
      }),
  };
}

const TEST_ACCOUNT_ID = '00000000-0000-0000-0000-000000000001';

const validBody = {
  topic: 'API 集成测试主题',
  directionMode: 'manual',
  publishMode: 'review',
  platform: 'xiaohongshu',
  accountId: TEST_ACCOUNT_ID,
};

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
    SCHEDULER_TOKEN,
    OPERATOR_TOKEN,
  };
  const handle = await buildApp({ db, env });
  app = handle.app;
});

afterAll(async () => {
  // SSE 测试的内部 afterAll 可能已关闭应用；重复关闭直接忽略
  try {
    await app.close();
  } catch {
    // 已关闭则忽略
  }
  await db.close();
});

beforeEach(async () => {
  // 保留账号夹具，清空业务数据
  await truncateAll(db);
  await db.db
    .insert(platformAccounts)
    .values({
      id: TEST_ACCOUNT_ID,
      alias: '测试账号',
      platform: 'xiaohongshu',
      secretRef: 'env:XHS_ACCOUNT_TEST',
    })
    .onConflictDoNothing();
});

describe('创建运行任务的认证与校验', () => {
  it('未携带凭据返回 401', async () => {
    const response = await api().post('/api/v1/runs', validBody, '');
    expect(response.statusCode).toBe(401);
  });

  it('凭据无效返回 401 且不创建任务', async () => {
    const response = await api().post('/api/v1/runs', validBody, 'wrong-token');
    expect(response.statusCode).toBe(401);
    const runs = await db.client.execute('SELECT id FROM content_job');
    expect(runs.rows).toHaveLength(0);
  });

  it('运营人员创建有效任务返回 201 QUEUED 并写审计', async () => {
    const response = await api().post('/api/v1/runs', validBody, OPERATOR_TOKEN, {
      'x-operator-id': 'zhang',
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { runId: string; status: string; version: number };
    expect(body.status).toBe('QUEUED');
    expect(body.version).toBe(1);

    const audits = await db.client.execute('SELECT action, actor_id FROM audit_event');
    const rows = audits.rows as unknown as Array<{ action: string; actor_id: string }>;
    expect(
      rows.some(
        (row) => row.action === 'run.created' && row.actor_id === 'operator:zhang',
      ),
    ).toBe(true);
  });

  it('不支持的平台返回校验错误且不创建任务', async () => {
    const response = await api().post('/api/v1/runs', {
      ...validBody,
      platform: 'zhihu',
    });
    expect(response.statusCode).toBe(400);
    const runs = await db.client.execute('SELECT id FROM content_job');
    expect(runs.rows).toHaveLength(0);
  });

  it('账号不存在返回 404', async () => {
    const response = await api().post('/api/v1/runs', {
      ...validBody,
      accountId: '00000000-0000-0000-0000-00000000dead',
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('调度器幂等触发', () => {
  it('调度器缺幂等键返回 400', async () => {
    const response = await api().post('/api/v1/runs', validBody, SCHEDULER_TOKEN);
    expect(response.statusCode).toBe(400);
  });

  it('相同幂等键与载荷重放返回原运行', async () => {
    const first = await api().post('/api/v1/runs', validBody, SCHEDULER_TOKEN, {
      'idempotency-key': 'cron-key-1',
    });
    expect(first.statusCode).toBe(201);

    const second = await api().post('/api/v1/runs', validBody, SCHEDULER_TOKEN, {
      'idempotency-key': 'cron-key-1',
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers['x-idempotent-replay']).toBe('true');
    expect((second.json() as { runId: string }).runId).toBe(
      (first.json() as { runId: string }).runId,
    );

    const jobs = await db.client.execute('SELECT id FROM content_job');
    expect(jobs.rows).toHaveLength(1);
  });

  it('相同幂等键不同载荷返回 409', async () => {
    const first = await api().post('/api/v1/runs', validBody, SCHEDULER_TOKEN, {
      'idempotency-key': 'cron-key-2',
    });
    expect(first.statusCode).toBe(201);

    const second = await api().post(
      '/api/v1/runs',
      { ...validBody, topic: '另一个主题' },
      SCHEDULER_TOKEN,
      {
        'idempotency-key': 'cron-key-2',
      },
    );
    expect(second.statusCode).toBe(409);
  });
});

describe('列表、详情与守卫', () => {
  it('列表返回创建的运行', async () => {
    await api().post('/api/v1/runs', validBody);
    const response = await api().get('/api/v1/runs');
    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: Array<{ topic: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]?.topic).toBe(validBody.topic);
  });

  it('详情包含步骤与事件，未知 id 返回 404', async () => {
    const created = await api().post('/api/v1/runs', validBody);
    const runId = (created.json() as { runId: string }).runId;

    const detail = await api().get(`/api/v1/runs/${runId}`);
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as { steps: unknown[]; events: unknown[] };
    expect(Array.isArray(body.steps)).toBe(true);
    expect(body.events.length).toBeGreaterThan(0);

    const missing = await api().get('/api/v1/runs/00000000-0000-0000-0000-00000000dead');
    expect(missing.statusCode).toBe(404);
  });

  it('调度器身份不能执行人工选向', async () => {
    const created = await api().post('/api/v1/runs', validBody);
    const runId = (created.json() as { runId: string }).runId;
    const response = await api().post(
      `/api/v1/runs/${runId}/direction-selection`,
      {
        directionId: TEST_ACCOUNT_ID,
      },
      SCHEDULER_TOKEN,
    );
    expect(response.statusCode).toBe(403);
  });

  it('无失败步骤时重试返回 409', async () => {
    const created = await api().post('/api/v1/runs', validBody);
    const runId = (created.json() as { runId: string }).runId;
    const response = await api().post(`/api/v1/runs/${runId}/retry`, {});
    expect(response.statusCode).toBe(409);
  });

  it('QUEUED 状态取消立即终态化', async () => {
    const created = await api().post('/api/v1/runs', validBody);
    const runId = (created.json() as { runId: string }).runId;
    const response = await api().post(`/api/v1/runs/${runId}/cancel`, {
      reason: '不需要了',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { status: string };
    expect(body.status).toBe('CANCELLED');
  });
});

describe('SSE 流', () => {
  let listenPort: number;

  beforeAll(async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    listenPort = typeof address === 'object' && address !== null ? address.port : 0;
  });

  afterAll(async () => {
    // afterAll 中 app.close 会同时关闭监听（见外层 afterAll 前执行）
    // Fastify 不允许 close 两次，因此这里先关闭
    try {
      await app.close();
    } catch {
      // 已关闭则忽略
    }
  });

  it('缺少凭据返回 401', async () => {
    const created = await api().post('/api/v1/runs', validBody);
    const runId = (created.json() as { runId: string }).runId;
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/runs/${runId}/events/stream`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('access_token 认证后补发历史事件并保持流打开', async () => {
    const created = await api().post('/api/v1/runs', validBody);
    const runId = (created.json() as { runId: string }).runId;

    const controller = new AbortController();
    try {
      const response = await fetch(
        `http://127.0.0.1:${listenPort}/api/v1/runs/${runId}/events/stream?access_token=${encodeURIComponent(OPERATOR_TOKEN)}`,
        { signal: controller.signal, headers: { accept: 'text/event-stream' } },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      // 读取首块：应包含补发的 run.created 事件
      const reader = response.body?.getReader();
      const first = reader !== undefined ? await reader.read() : null;
      const text =
        first?.value !== undefined ? new TextDecoder().decode(first.value) : '';
      expect(text).toContain('event: run.created');
    } finally {
      controller.abort();
    }
  });
});
