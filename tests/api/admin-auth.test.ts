import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAdminUser, hashAdminPassword, type DbClient } from '@tutor-flow/db';
import type { ApiEnv } from '@tutor-flow/config/server';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../apps/api/src/app.js';
import {
  createTestDb,
  setupTestDatabase,
  TEST_DATABASE_URL,
  truncateAll,
} from '../db/setup.js';

let db: DbClient;
let app: FastifyInstance;

async function login(username: string, password: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  const cookie = response.headers['set-cookie'];
  expect(cookie).toBeTypeOf('string');
  expect(cookie).toContain('Max-Age=7776000');
  return String(cookie).split(';')[0] ?? '';
}

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
  await createAdminUser(db.db, {
    username: 'root',
    passwordHash: await hashAdminPassword('root-password-123'),
    role: 'SUPER_ADMIN',
  });
  await createAdminUser(db.db, {
    username: 'operator',
    passwordHash: await hashAdminPassword('operator-password-123'),
    role: 'ADMIN',
  });
});

describe('管理后台认证与权限', () => {
  it('使用 HttpOnly Cookie 登录并读取当前用户', async () => {
    const cookie = await login('root', 'root-password-123');
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      user: { username: 'root', role: 'SUPER_ADMIN' },
    });
  });

  it('SUPER_ADMIN 可以创建 ADMIN 并随机重置密码', async () => {
    const cookie = await login('root', 'root-password-123');
    const tooShort = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: { cookie },
      payload: { username: 'tiny', password: 'abcd' },
    });
    expect(tooShort.statusCode).toBe(400);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: { cookie },
      payload: { username: 'editor', password: 'abcde' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ username: 'editor', role: 'ADMIN' });

    const reset = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${created.json().id as string}/reset-password`,
      headers: { cookie },
      payload: { mode: 'random' },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().password).toMatch(/^.{20}$/);
  });

  it('ADMIN 不能管理其他用户，但可以修改自己的密码', async () => {
    const cookie = await login('operator', 'operator-password-123');
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: { cookie },
    });
    expect(list.statusCode).toBe(403);

    const changed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: { cookie },
      payload: {
        currentPassword: 'operator-password-123',
        newPassword: 'abcde',
      },
    });
    expect(changed.statusCode).toBe(200);
    await expect(login('operator', 'abcde')).resolves.toContain('tutor_flow_session=');
  });
});
