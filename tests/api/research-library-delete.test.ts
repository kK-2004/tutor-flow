import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ApiEnv } from '@tutor-flow/config/server';
import type { DbClient } from '@tutor-flow/db';

import { buildApp } from '../../apps/api/src/app.js';
import {
  createTestDb,
  setupTestDatabase,
  truncateAll,
  TEST_DATABASE_URL,
} from '../db/setup.js';

const token = 'research-delete-operator';
const headers = { authorization: `Bearer ${token}` };
let app: FastifyInstance;
let db: DbClient;

async function createDocument(title: string, markdown: string, folderId?: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/research-library/documents',
    headers,
    payload: { title, markdown, folderId },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string };
}

describe('研究资料删除与内容中心清理', () => {
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
      vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        const ids = (JSON.parse(init?.body as string) as { fileIds: number[] }).fileIds;
        return new Response(
          JSON.stringify({ deletedFiles: ids.length, failedObjects: 0 }),
          {
            status: 200,
          },
        );
      }),
    );
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    delete process.env['KFILE_APP_TOKEN_TEST'];
    await app.close();
    await db.close();
  });

  it('物理删除资料，只清理不再被其他资料引用的图片', async () => {
    const first = await createDocument(
      '第一篇',
      '![独有](content-center://file/41) ![共享](content-center://file/42)',
    );
    const second = await createDocument('第二篇', '![共享](content-center://file/42)');

    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/v1/research-library/documents',
      headers,
      payload: { ids: [first.id] },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({
      deletedDocuments: 1,
      cleanup: {
        deletedFiles: 1,
        failedObjects: 0,
        retainedFiles: 1,
        failedFileIds: [],
      },
    });
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0]?.[1]?.body as string)).toEqual({
      fileIds: [41],
    });
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/research-library',
      headers,
    });
    expect(
      (list.json() as { documents: Array<{ id: string }> }).documents.map(
        (doc) => doc.id,
      ),
    ).toEqual([second.id]);

    const last = await app.inject({
      method: 'DELETE',
      url: '/api/v1/research-library/documents',
      headers,
      payload: { ids: [second.id] },
    });
    expect(last.statusCode).toBe(200);
    expect(JSON.parse(vi.mocked(fetch).mock.calls[1]?.[1]?.body as string)).toEqual({
      fileIds: [42],
    });
  });

  it('删除文件夹时递归清理子文件夹资料的图片', async () => {
    const parent = await app.inject({
      method: 'POST',
      url: '/api/v1/research-library/folders',
      headers,
      payload: { name: '父文件夹' },
    });
    expect(parent.statusCode).toBe(201);
    const child = await app.inject({
      method: 'POST',
      url: '/api/v1/research-library/folders',
      headers,
      payload: { name: '子文件夹', parentId: (parent.json() as { id: string }).id },
    });
    expect(child.statusCode).toBe(201);
    await createDocument(
      '子资料',
      '![图](content-center://file/51)',
      (child.json() as { id: string }).id,
    );

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/research-library/folders/${(parent.json() as { id: string }).id}`,
      headers,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({
      deletedDocuments: 1,
      cleanup: { deletedFiles: 1 },
    });
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0]?.[1]?.body as string)).toEqual({
      fileIds: [51],
    });
  });

  it('内容中心失败时返回待清理 ID，资料删除仍生效', async () => {
    const document = await createDocument('失败示例', '![图](content-center://file/61)');
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ message: '暂不可用' }), { status: 503 }),
        ),
    );
    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/v1/research-library/documents',
      headers,
      payload: { ids: [document.id] },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({
      deletedDocuments: 1,
      cleanup: { failedFileIds: [61] },
    });
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/research-library',
      headers,
    });
    expect((list.json() as { documents: unknown[] }).documents).toEqual([]);
  });
});
