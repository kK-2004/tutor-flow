import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ApiEnv } from '@tutor-flow/config/server';
import { upsertSetting, type DbClient } from '@tutor-flow/db';

import { buildApp } from '../../apps/api/src/app.js';
import {
  createTestDb,
  setupTestDatabase,
  truncateAll,
  TEST_DATABASE_URL,
} from '../db/setup.js';

const token = 'media-test-operator';
let app: FastifyInstance;
let db: DbClient;

describe('内容中心媒体路由', () => {
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
      OPERATOR_TOKEN: token,
      CONTENT_CENTER_URL: 'https://content.example',
      CONTENT_CENTER_TOKEN_REF: 'env:KFILE_APP_TOKEN_TEST',
    };
    app = (await buildApp({ db, env })).app;
  });

  beforeEach(async () => {
    await truncateAll(db);
    process.env['KFILE_APP_TOKEN_TEST'] = 'kapp_test';
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            storageKey: 'tutor-flow/cover.png',
            source: 'minio',
            putUrl: 'https://storage.example/put?signature=secret',
            expiresIn: 300,
            fileId: 42,
          }),
          { status: 200 },
        ),
      ),
    );
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    delete process.env['KFILE_APP_TOKEN_TEST'];
    await app.close();
    await db.close();
  });

  it('校验图片后申请 MinIO 预签名地址', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/media/uploads/init',
      headers: { authorization: `Bearer ${token}` },
      payload: { filename: 'cover.png', size: 123, contentType: 'image/png' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().source).toBe('minio');
    const fetcher = vi.mocked(fetch);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      originalName: 'cover.png',
      path: 'tutor-flow',
      source: 'minio',
    });
  });

  it('拒绝不支持的格式和未认证请求', async () => {
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/media/uploads/init',
      headers: { authorization: `Bearer ${token}` },
      payload: { filename: 'cover.svg', size: 123, contentType: 'image/svg+xml' },
    });
    expect(invalid.statusCode).toBe(400);
    const unauthorized = await app.inject({
      method: 'POST',
      url: '/api/v1/media/uploads/init',
      payload: { filename: 'cover.png', size: 123, contentType: 'image/png' },
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('上传确认返回可持久化引用', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            fileId: 42,
            name: 'cover.png',
            size: 123,
            contentType: 'image/png',
          }),
          { status: 200 },
        ),
      ),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/media/uploads/complete',
      headers: { authorization: `Bearer ${token}` },
      payload: { storageKey: 'tutor-flow/cover.png', source: 'minio' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().media).toEqual({
      fileId: 42,
      name: 'cover.png',
      contentType: 'image/png',
    });
  });

  it('链接有效期从设置表热读取', async () => {
    await upsertSetting(db.db, {
      key: 'content_center',
      updatedBy: 'test',
      value: {
        source: 'minio',
        path: 'team/images',
        maxUploadBytes: 1024,
        downloadExpiresIn: 600,
        cdnExpiresIn: 120,
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            url: 'https://cdn.example/cover.png',
            expiresIn: 120,
            permanent: false,
            contentType: 'image/png',
          }),
          { status: 200 },
        ),
      ),
    );
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/media/42/cdn-link',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0]?.[1]?.body as string)).toEqual({
      fileId: 42,
      expiresIn: 120,
    });
  });

  it('后台更新大小限制后立即拒绝超限图片', async () => {
    const saved = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings/content_center',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        value: {
          source: 'minio',
          path: 'team/images',
          maxUploadBytes: 100,
          downloadExpiresIn: 600,
          cdnExpiresIn: 120,
        },
      },
    });
    expect(saved.statusCode).toBe(200);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/media/uploads/init',
      headers: { authorization: `Bearer ${token}` },
      payload: { filename: 'cover.png', size: 101, contentType: 'image/png' },
    });
    expect(response.statusCode).toBe(413);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
