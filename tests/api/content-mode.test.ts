import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  appendAuditEvent,
  createAdminUser,
  createRun,
  hashAdminPassword,
  seedDefaultSettings,
  type DbClient,
} from '@tutor-flow/db';
import type { FastifyInstance } from 'fastify';
import type { ApiEnv } from '@tutor-flow/config/server';
import { buildApp } from '../../apps/api/src/app.js';
import {
  createTestDb,
  setupTestDatabase,
  TEST_DATABASE_URL,
  truncateAll,
} from '../db/setup.js';

let db: DbClient;
let app: FastifyInstance;
let cookie: string;
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
  };
  app = (await buildApp({ db, env })).app;
});
afterAll(async () => {
  await app.close();
  await db.close();
});
beforeEach(async () => {
  await truncateAll(db);
  await seedDefaultSettings(db.db);
  await createAdminUser(db.db, {
    username: 'root',
    passwordHash: await hashAdminPassword('root-password-123'),
    role: 'SUPER_ADMIN',
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: 'root', password: 'root-password-123' },
  });
  cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
});

describe('仅生成内容的控制面', () => {
  it('设置提示词即刻写入，错误提示词和旧发布入口被拒绝', async () => {
    const setting = await app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: { cookie },
    });
    const original = setting
      .json()
      .items.find((item: { key: string }) => item.key === 'xiaohongshu_prompt');
    expect(original.value.systemPrompt).toContain('标题');
    const replacement =
      '请为目标读者写出清晰、具体、可收藏的小红书内容，严格依据已核验事实，避免编造效果和亲历；标题明确价值，正文给出适用条件和可操作步骤。';
    const updated = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings/xiaohongshu_prompt',
      headers: { cookie },
      payload: {
        value: { systemPrompt: replacement },
        expectedVersion: original.version,
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().value.systemPrompt).toBe(replacement);
    const invalid = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings/xiaohongshu_prompt',
      headers: { cookie },
      payload: { value: { systemPrompt: '太短' } },
    });
    expect(invalid.statusCode).toBe(400);
    const publish = await app.inject({
      method: 'POST',
      url: '/api/v1/publish-jobs/old/retry',
      headers: { cookie },
      payload: {},
    });
    expect(publish.statusCode).toBe(404);
    const loginQrcode = await app.inject({
      method: 'POST',
      url: '/api/v1/xiaohongshu/session/login-qrcode',
      headers: { cookie },
      payload: {},
    });
    expect(loginQrcode.statusCode).toBe(404);
  });

  it('最近活动只返回工作流事件，包含调度启动和步骤，不混入登录审计', async () => {
    const created = await createRun(db.db, {
      callerIdentity: 'scheduler:test',
      requestHash: 'hash',
      topic: '内容测试',
      directionMode: 'auto',
      publishMode: 'review',
      platform: 'xiaohongshu',
      accountId: '00000000-0000-4000-8000-000000000001',
      triggerType: 'scheduler',
      triggeredBy: 'scheduler:test',
    });
    await appendAuditEvent(db.db, {
      actorType: 'operator',
      actorId: 'root',
      action: 'admin.login',
      resourceType: 'admin_user',
      resourceId: 'root',
      payload: {},
    });
    const result = await app.inject({
      method: 'GET',
      url: '/api/v1/overview',
      headers: { cookie },
    });
    expect(result.statusCode).toBe(200);
    const activity = result.json().recentActivity;
    expect(activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'run.created',
          runId: created.runId,
          payload: expect.objectContaining({ triggerType: 'scheduler' }),
        }),
      ]),
    );
    expect(
      activity.some((item: { action: string }) => item.action === 'admin.login'),
    ).toBe(false);
  });
});
