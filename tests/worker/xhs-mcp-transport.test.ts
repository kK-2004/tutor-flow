import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHttpMcpToolCaller } from '@tutor-flow/integrations';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('小红书 Streamable HTTP MCP 传输', () => {
  it('先握手再调用 tools/call，并向鉴权代理发送令牌', async () => {
    const requests: Array<{
      method: string;
      url: string;
      body: unknown;
      token: string | null;
    }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const body =
          request.method === 'POST'
            ? ((await request.json()) as {
                id?: number;
                method?: string;
                params?: { name?: string; arguments?: Record<string, unknown> };
              })
            : null;
        requests.push({
          method: request.method,
          url: request.url,
          body,
          token: request.headers.get('authorization'),
        });
        if (request.method === 'GET') return new Response(null, { status: 405 });
        if (request.method === 'DELETE') return new Response(null, { status: 405 });
        if (body?.method === 'notifications/initialized') {
          return new Response(null, { status: 202 });
        }
        if (body?.method === 'initialize') {
          return Response.json({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'xiaohongshu-mcp', version: '2.0.0' },
            },
          });
        }
        if (body?.method === 'tools/call') {
          return Response.json({
            jsonrpc: '2.0',
            id: body.id,
            result: { content: [{ type: 'text', text: '✅ 已登录\n用户名: 测试账号' }] },
          });
        }
        throw new Error(`未预期的 MCP 请求：${body?.method ?? request.method}`);
      }),
    );

    const callTool = createHttpMcpToolCaller(
      'http://sidecar.local/',
      5_000,
      async () => 'test-token',
    );
    const result = await callTool('check_login_status', {});

    expect(result).toMatchObject({
      content: [{ type: 'text', text: '✅ 已登录\n用户名: 测试账号' }],
    });
    const call = requests.find(
      (item) => (item.body as { method?: string } | null)?.method === 'tools/call',
    );
    expect(call?.url).toBe('http://sidecar.local/mcp');
    expect(call?.token).toBe('Bearer test-token');
    expect((call?.body as { params?: unknown }).params).toEqual({
      name: 'check_login_status',
      arguments: {},
    });
    expect(
      requests.some(
        (item) => (item.body as { method?: string } | null)?.method === 'initialize',
      ),
    ).toBe(true);
  });
});
