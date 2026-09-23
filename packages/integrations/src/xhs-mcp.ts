/**
 * 小红书 MCP 适配器（任务 6.4）。
 *
 * 使用标准 Streamable HTTP MCP 客户端连接 xpzouying/xiaohongshu-mcp。
 * 容器持有单份登录态；发布成功但未返回笔记 ID 时必须转人工核验。
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  PublisherError,
  type AuthCheckResult,
  type PublishContent,
  type PublishPreviewResult,
  type PublishResult,
  type PublisherAccountRef,
  type PublisherAdapter,
  type PublishStatusResult,
  type PublishValidateResult,
} from './publisher.js';

/** MCP 工具调用抽象：由传输层实现（HTTP/SSE），测试可注入桩 */
export type McpToolCaller = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export interface McpAdapterOptions {
  callTool: McpToolCaller;
  /** 当前容器登录态在本平台绑定的唯一账号 ID。 */
  boundAccountId?: string;
  /** 发布前按内容中心文件 ID 换取最新 CDN 链接。 */
  resolveMediaUrl?: (fileId: number) => Promise<string>;
  /** 单次工具调用超时（毫秒） */
  timeoutMs?: number;
}

export interface XhsMcpLoginStatus {
  loggedIn: boolean;
  username?: string;
  userId?: string;
}

export interface XhsMcpLoginQrcode {
  alreadyLoggedIn: boolean;
  qrCodeDataUrl?: string;
  expiresInSeconds: number;
}

export interface XhsMcpSessionClient {
  checkLoginStatus(): Promise<XhsMcpLoginStatus>;
  getLoginQrcode(): Promise<XhsMcpLoginQrcode>;
  logout(): Promise<void>;
}

interface McpContentItem {
  type?: unknown;
  text?: unknown;
  data?: unknown;
  mimeType?: unknown;
}

function readToolResult(raw: unknown, tool: string): McpContentItem[] {
  if (typeof raw !== 'object' || raw === null) {
    throw new PublisherError('TRANSIENT', `${tool} 响应为空`);
  }
  const result = raw as { isError?: unknown; content?: McpContentItem[] };
  if (result.isError === true) {
    throw new PublisherError('TRANSIENT', `${tool} 执行失败`);
  }
  if (!Array.isArray(result.content)) {
    throw new PublisherError('SELECTOR', `${tool} 响应内容缺失`);
  }
  return result.content;
}

function readSessionText(content: McpContentItem[], tool: string): string {
  const text = content.find((item) => item.type === 'text')?.text;
  if (typeof text !== 'string' || text.trim() === '') {
    throw new PublisherError('SELECTOR', `${tool} 文本响应缺失`);
  }
  return text.trim();
}

/** 创建小红书 MCP 登录会话客户端。 */
export function createXhsMcpSessionClient(callTool: McpToolCaller): XhsMcpSessionClient {
  return {
    async checkLoginStatus() {
      const content = readToolResult(
        await callTool('check_login_status', {}),
        'check_login_status',
      );
      const text = readSessionText(content, 'check_login_status');
      if (text.startsWith('❌ 未登录')) return { loggedIn: false };
      if (!text.startsWith('✅ 已登录')) {
        throw new PublisherError('SELECTOR', '登录状态文本与上游契约不符');
      }
      const username = /(?:用户名|昵称)[:：]\s*([^\n]+)/.exec(text)?.[1]?.trim();
      const userId = /(?:用户\s*ID|用户ID)[:：]\s*([^\n]+)/i.exec(text)?.[1]?.trim();
      return {
        loggedIn: true,
        ...(username ? { username } : {}),
        ...(userId ? { userId } : {}),
      };
    },

    async getLoginQrcode() {
      const content = readToolResult(
        await callTool('get_login_qrcode', {}),
        'get_login_qrcode',
      );
      const text = readSessionText(content, 'get_login_qrcode');
      if (text.includes('已处于登录状态')) {
        return { alreadyLoggedIn: true, expiresInSeconds: 0 };
      }
      const image = content.find((item) => item.type === 'image');
      if (
        typeof image?.data !== 'string' ||
        image.data === '' ||
        typeof image.mimeType !== 'string' ||
        !image.mimeType.startsWith('image/')
      ) {
        throw new PublisherError('SELECTOR', '登录二维码图片缺失');
      }
      return {
        alreadyLoggedIn: false,
        qrCodeDataUrl: `data:${image.mimeType};base64,${image.data}`,
        expiresInSeconds: 240,
      };
    },

    async logout() {
      const content = readToolResult(
        await callTool('delete_cookies', {}),
        'delete_cookies',
      );
      readSessionText(content, 'delete_cookies');
    },
  };
}

/** 单次调用超时的包装；超时视为结果未知（副作用可能已发生） */
async function callWithTimeout(
  callTool: McpToolCaller,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new PublisherError(
          'UNKNOWN_OUTCOME',
          `工具调用超时：${tool}`,
          tool === 'publish_content',
        ),
      );
    }, timeoutMs);
    void callTool(tool, args).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 上游 MCP 工具均返回文本内容，不能按自定义 JSON 回执解析。 */
function readToolText(raw: unknown, tool: string): string {
  if (typeof raw !== 'object' || raw === null) {
    throw new PublisherError(
      tool === 'publish_content' ? 'NEEDS_HUMAN' : 'SELECTOR',
      `${tool} 响应为空`,
      tool === 'publish_content',
    );
  }
  const result = raw as {
    isError?: unknown;
    content?: Array<{ type?: unknown; text?: unknown }>;
  };
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (result.isError === true) {
    throw new PublisherError(
      tool === 'publish_content' ? 'NEEDS_HUMAN' : 'TRANSIENT',
      `${tool} 执行失败，请检查上游登录态或容器日志`,
      tool === 'publish_content',
    );
  }
  if (typeof text !== 'string' || text.trim() === '') {
    throw new PublisherError(
      tool === 'publish_content' ? 'NEEDS_HUMAN' : 'SELECTOR',
      `${tool} 文本响应缺失`,
      tool === 'publish_content',
    );
  }
  return text.trim();
}

/** 创建 xiaohongshu-mcp Publisher Adapter */
export function createMcpPublisherAdapter(options: McpAdapterOptions): PublisherAdapter {
  const callTool = options.callTool;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const invoke = async (tool: string, args: Record<string, unknown>): Promise<string> => {
    try {
      const raw = await callWithTimeout(callTool, tool, args, timeoutMs);
      return readToolText(raw, tool);
    } catch (error) {
      if (error instanceof PublisherError) {
        throw error;
      }
      // 发布请求的传输异常可能发生在平台副作用之后，禁止盲目重发。
      throw new PublisherError(
        tool === 'publish_content' ? 'NEEDS_HUMAN' : 'TRANSIENT',
        `MCP ${tool} 调用失败`,
        tool === 'publish_content',
      );
    }
  };

  return {
    sessionMode: 'sidecar',

    async checkAuth(account: PublisherAccountRef): Promise<AuthCheckResult> {
      if (
        options.boundAccountId !== undefined &&
        account.accountId !== options.boundAccountId
      ) {
        throw new PublisherError('REJECTED', '该账号不是 MCP 容器当前绑定的账号');
      }
      const status = await invoke('check_login_status', {});
      if (status.startsWith('✅ 已登录')) {
        return { healthy: 'HEALTHY' };
      }
      if (status.startsWith('❌ 未登录')) {
        return { healthy: 'AUTH_REQUIRED', message: '上游容器未登录，请扫码登录' };
      }
      throw new PublisherError('SELECTOR', '登录状态文本与上游契约不符');
    },

    async validate(
      account: PublisherAccountRef,
      content: PublishContent,
    ): Promise<PublishValidateResult> {
      if (
        options.boundAccountId !== undefined &&
        account.accountId !== options.boundAccountId
      ) {
        return { valid: false, issues: ['该账号不是 MCP 容器当前绑定的账号'] };
      }
      if (content.mediaObjectKeys.length === 0) {
        return { valid: false, issues: ['适配器要求至少一张图片'] };
      }
      if (
        content.mediaObjectKeys.some(
          (media) =>
            typeof media === 'string' &&
            !/^https?:\/\//i.test(media) &&
            !media.startsWith('/'),
        )
      ) {
        return { valid: false, issues: ['普通媒体键不是上游可访问的图片地址或绝对路径'] };
      }
      return { valid: true, issues: [] };
    },

    async preview(
      _account: PublisherAccountRef,
      content: PublishContent,
    ): Promise<PublishPreviewResult> {
      return {
        payload: {
          tool: 'publish_content',
          args: {
            title: content.title,
            content: content.body,
            tags: content.tags,
            imageCount: content.mediaObjectKeys.length,
          },
        },
      };
    },

    async publish(
      account: PublisherAccountRef,
      content: PublishContent,
    ): Promise<PublishResult> {
      if (
        options.boundAccountId !== undefined &&
        account.accountId !== options.boundAccountId
      ) {
        throw new PublisherError('REJECTED', '该账号不是 MCP 容器当前绑定的账号');
      }
      const imageUrls = await Promise.all(
        content.mediaObjectKeys.map(async (media) => {
          if (typeof media === 'string') return media;
          if (options.resolveMediaUrl === undefined) {
            throw new PublisherError('REJECTED', '内容中心媒体链接解析器未配置');
          }
          try {
            return await options.resolveMediaUrl(media.fileId);
          } catch {
            throw new PublisherError('TRANSIENT', '内容中心媒体链接获取失败');
          }
        }),
      );
      const result = await invoke('publish_content', {
        title: content.title,
        content: content.body,
        tags: content.tags,
        images: imageUrls,
      });
      if (result.startsWith('内容发布成功:')) {
        throw new PublisherError(
          'NEEDS_HUMAN',
          '上游报告发布完成，但未返回笔记 ID；需人工确认已发布或未发布',
          true,
        );
      }
      throw new PublisherError(
        'NEEDS_HUMAN',
        '上游发布响应无法确认结果，需人工核验',
        true,
      );
    },

    async queryStatus(
      _account: PublisherAccountRef,
      _platformPostId: string,
    ): Promise<PublishStatusResult> {
      throw new PublisherError('NEEDS_HUMAN', '上游未提供按笔记 ID 核验发布状态的工具');
    },
  };
}

/** 官方 MCP 客户端负责握手、会话与 Streamable HTTP 响应解析。 */
export function createHttpMcpToolCaller(
  endpoint: string,
  timeoutMs = 60_000,
  resolveAuthToken?: () => Promise<string>,
): McpToolCaller {
  return async (tool, args) => {
    const url = new URL(endpoint);
    if (url.pathname === '/') url.pathname = '/mcp';
    const token = await resolveAuthToken?.();
    const client = new Client(
      { name: 'tutor-flow', version: '0.1.0' },
      { versionNegotiation: { mode: 'legacy' } },
    );
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: {
        ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      },
    });
    try {
      await client.connect(transport);
      return await client.callTool(
        { name: tool, arguments: args },
        { timeout: timeoutMs },
      );
    } finally {
      await client.close().catch(() => undefined);
    }
  };
}
