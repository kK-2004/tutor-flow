import { describe, expect, it, vi } from 'vitest';

import { createXhsMcpSessionClient } from './xhs-mcp.js';

describe('小红书 MCP 登录会话', () => {
  it('解析二维码图片并调用正确工具', async () => {
    const callTool = vi.fn(async () => ({
      content: [
        { type: 'text', text: '请用小红书 App 扫码登录' },
        { type: 'image', mimeType: 'image/png', data: 'cG5n' },
      ],
    }));
    const session = createXhsMcpSessionClient(callTool);

    await expect(session.getLoginQrcode()).resolves.toEqual({
      alreadyLoggedIn: false,
      qrCodeDataUrl: 'data:image/png;base64,cG5n',
      expiresInSeconds: 240,
    });
    expect(callTool).toHaveBeenCalledWith('get_login_qrcode', {});
  });

  it('解析已登录账号信息', async () => {
    const session = createXhsMcpSessionClient(async () => ({
      content: [
        {
          type: 'text',
          text: '✅ 已登录\n用户名: 测试账号\n用户ID: xhs-user-1',
        },
      ],
    }));

    await expect(session.checkLoginStatus()).resolves.toEqual({
      loggedIn: true,
      username: '测试账号',
      userId: 'xhs-user-1',
    });
  });
});

describe('小红书登录失败与并发保护', () => {
  it('合并在途状态检查，完成后重新查询而不缓存旧状态', async () => {
    let finish!: (value: unknown) => void;
    const callTool = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          finish = resolve;
        }),
    );
    const session = createXhsMcpSessionClient(callTool);
    const first = session.checkLoginStatus();
    const second = session.checkLoginStatus();
    expect(callTool).toHaveBeenCalledTimes(1);
    finish({ content: [{ type: 'text', text: '❌ 未登录' }] });
    await expect(first).resolves.toEqual({ loggedIn: false });
    await expect(second).resolves.toEqual({ loggedIn: false });
    const third = session.checkLoginStatus();
    expect(callTool).toHaveBeenCalledTimes(2);
    finish({ content: [{ type: 'text', text: '✅ 已登录' }] });
    await expect(third).resolves.toEqual({ loggedIn: true });
  });

  it('合并并发二维码请求，避免上游创建多个扫码浏览器', async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: '已处于登录状态' }],
    }));
    const session = createXhsMcpSessionClient(callTool);
    await Promise.all([session.getLoginQrcode(), session.getLoginQrcode()]);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('超时后返回可识别错误并允许重试', async () => {
    const callTool = vi
      .fn()
      .mockRejectedValueOnce(new Error('Request timed out: secret-value'))
      .mockResolvedValue({ content: [{ type: 'text', text: '✅ 已登录' }] });
    const session = createXhsMcpSessionClient(callTool);
    await expect(session.checkLoginStatus()).rejects.toMatchObject({
      code: 'XHS_TIMEOUT',
    });
    await expect(session.checkLoginStatus()).resolves.toEqual({ loggedIn: true });
  });

  it('区分上游故障与响应契约不兼容', async () => {
    const session = createXhsMcpSessionClient(
      vi
        .fn()
        .mockResolvedValueOnce({ isError: true, content: [] })
        .mockResolvedValueOnce({ content: [{ type: 'text', text: '未知状态' }] }),
    );
    await expect(session.checkLoginStatus()).rejects.toMatchObject({
      code: 'XHS_UNAVAILABLE',
    });
    await expect(session.checkLoginStatus()).rejects.toMatchObject({
      code: 'XHS_CONTRACT_ERROR',
    });
  });
});
