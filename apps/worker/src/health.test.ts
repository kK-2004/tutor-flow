import { describe, expect, it } from 'vitest';

import { HealthServer, type ReadinessCheck } from './health.js';

/**
 * Worker 健康检查服务测试。
 *
 * 使用操作系统随机分配端口，避免与本地已运行服务冲突。
 */
async function startServer(readinessChecks: ReadinessCheck[]): Promise<HealthServer> {
  const server = new HealthServer({ port: 0, readinessChecks });
  // 等待 listen 完成后再读取实际端口
  await new Promise<void>((resolve) => {
    setImmediate(() => {
      resolve();
    });
  });
  return server;
}

async function getJson(
  port: number,
  path: string,
): Promise<{ code: number; body: object }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = (await response.json()) as object;
  return { code: response.status, body };
}

describe('Worker 健康检查服务', () => {
  it('healthz 返回存活状态', async () => {
    const server = await startServer([]);
    try {
      const result = await getJson(server.port, '/healthz');
      expect(result.code).toBe(200);
      expect(result.body).toEqual({ status: 'ok' });
    } finally {
      await server.close();
    }
  });

  it('readyz 全部通过时返回 ready', async () => {
    const server = await startServer([
      {
        name: 'always-ok',
        check: async () => undefined,
      },
    ]);
    try {
      const result = await getJson(server.port, '/readyz');
      expect(result.code).toBe(200);
      expect(result.body).toEqual({ status: 'ready' });
    } finally {
      await server.close();
    }
  });

  it('readyz 任一检查失败时返回 503 与失败项，且不泄露错误细节', async () => {
    const server = await startServer([
      {
        name: 'always-ok',
        check: async () => undefined,
      },
      {
        name: 'always-fails',
        check: async () => {
          throw new Error('敏感依赖错误细节');
        },
      },
    ]);
    try {
      const result = await getJson(server.port, '/readyz');
      expect(result.code).toBe(503);
      expect(result.body).toEqual({ status: 'degraded', failed: ['always-fails'] });
      expect(JSON.stringify(result.body)).not.toContain('敏感依赖错误细节');
    } finally {
      await server.close();
    }
  });

  it('未知路径返回 404', async () => {
    const server = await startServer([]);
    try {
      const result = await getJson(server.port, '/unknown');
      expect(result.code).toBe(404);
    } finally {
      await server.close();
    }
  });
});
