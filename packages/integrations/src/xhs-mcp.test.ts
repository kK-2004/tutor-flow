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
