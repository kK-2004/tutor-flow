import { describe, expect, it, vi } from 'vitest';

import { ContentCenterError, createContentCenterClient } from './content-center.js';

describe('内容中心开放 API 客户端', () => {
  it('按 Java SDK 的简单上传与 CDN 契约发送请求', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
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
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            fileId: 42,
            name: 'cover.png',
            size: 123,
            contentType: 'image/png',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            url: 'https://cdn.example/cover.png',
            expiresIn: 0,
            permanent: true,
            contentType: 'image/png',
          }),
          { status: 200 },
        ),
      );
    const client = createContentCenterClient({
      baseUrl: 'https://content.example/',
      appToken: 'kapp_test',
      fetcher,
    });

    const init = await client.initUpload('cover.png', {
      size: 123,
      contentType: 'image/png',
      path: 'tutor-flow',
      source: 'minio',
    });
    expect(init.fileId).toBe(42);
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toEqual({
      originalName: 'cover.png',
      size: 123,
      contentType: 'image/png',
      path: 'tutor-flow',
      source: 'minio',
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://content.example/api/open/uploads');
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer kapp_test',
    });
    const complete = await client.completeUpload(init.storageKey, init.source);
    expect(complete.fileId).toBe(42);
    expect(JSON.parse(fetcher.mock.calls[1]?.[1]?.body as string)).toEqual({
      storageKey: 'tutor-flow/cover.png',
      source: 'minio',
    });
    expect((await client.getCdnLink(42, 0)).permanent).toBe(true);
    expect(JSON.parse(fetcher.mock.calls[2]?.[1]?.body as string)).toEqual({
      fileId: 42,
      expiresIn: 0,
    });
  });

  it('HTTP 错误不会回显令牌或预签名地址', async () => {
    const client = createContentCenterClient({
      baseUrl: 'https://content.example',
      appToken: 'kapp_test',
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            message: '无权访问',
          }),
          { status: 403 },
        ),
      ),
    });
    await expect(client.initUpload('cover.png')).rejects.toEqual(
      new ContentCenterError(403, '无权访问'),
    );
  });

  it('批量删除仅提交文件 ID，并返回删除结果', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ deletedFiles: 2, failedObjects: 0 }), {
        status: 200,
      }),
    );
    const client = createContentCenterClient({
      baseUrl: 'https://content.example/',
      appToken: 'kapp_test',
      fetcher,
    });

    await expect(client.deleteFiles([41, 42])).resolves.toEqual({
      deletedFiles: 2,
      failedObjects: 0,
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      'https://content.example/api/open/files/batch-delete',
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: {
        authorization: 'Bearer kapp_test',
        'content-type': 'application/json',
      },
    });
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toEqual({
      fileIds: [41, 42],
    });
  });
});
