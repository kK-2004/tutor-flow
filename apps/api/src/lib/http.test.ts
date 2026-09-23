import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { XhsSessionError } from '@tutor-flow/integrations';
import { mapHttpError } from './http.js';

describe('小红书登录 HTTP 错误映射', () => {
  it.each([
    ['XHS_TIMEOUT', 504],
    ['XHS_UNAVAILABLE', 502],
    ['XHS_CONTRACT_ERROR', 502],
  ] as const)('%s 返回 %s 和安全提示', async (code, status) => {
    const app = Fastify();
    app.setErrorHandler(mapHttpError);
    app.get('/session', async () => {
      throw new XhsSessionError(code);
    });
    try {
      const response = await app.inject('/session');
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ code, error: new XhsSessionError(code).message });
    } finally {
      await app.close();
    }
  });
});
