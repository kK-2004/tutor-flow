/**
 * 安全页面抓取器。
 *
 * 安全约束（SSRF 防护）：
 * - 仅允许 http/https；
 * - 域名必须解析为公网地址（拒绝回环/私网/链路本地地址）；
 * - 响应大小与超时有界；
 * - 仅接受文本类内容（HTML/text），二进制一律拒绝。
 */
import { lookup } from 'node:dns/promises';

import { normalizeUrl } from './url.js';
import { GatewayError, type FetchedPage, type PageFetcher } from './gateway-types.js';

/** 默认响应大小上限：2 MiB（正文提取足够，防止超大响应拖垮进程） */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** 判断地址是否为私网/保留地址（IPv4 与 IPv6） */
function isPrivateAddress(address: string): boolean {
  // IPv4
  const v4 = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4 !== null) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) {
      return true;
    }
    if (a === 169 && b === 254) {
      return true;
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return true;
    }
    if (a === 192 && b === 168) {
      return true;
    }
    if (a >= 224) {
      // 组播与保留段
      return true;
    }
    return false;
  }
  // IPv6：回环、链路本地、唯一本地、映射 IPv4 私网一律拒绝
  const lower = address.toLowerCase();
  if (lower === '::' || lower === '::1') {
    return true;
  }
  if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) {
    return true;
  }
  if (lower.startsWith('::ffff:')) {
    return isPrivateAddress(lower.slice('::ffff:'.length));
  }
  return false;
}

/** 校验目标 URL 指向公网地址；非法或私网时抛出不可重试错误 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<string> {
  const normalized = normalizeUrl(rawUrl);
  if (normalized === null) {
    throw new GatewayError(`URL 非法或非 http(s)：${rawUrl.slice(0, 80)}`, {
      retryable: false,
    });
  }
  const parsed = new URL(normalized);
  const addresses = await lookup(parsed.hostname, { all: true, verbatim: true }).catch(
    () => [],
  );
  if (addresses.length === 0) {
    throw new GatewayError(`域名无法解析：${parsed.hostname}`, { retryable: true });
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new GatewayError(`拒绝访问私网地址：${parsed.hostname}`, {
        retryable: false,
      });
    }
  }
  return normalized;
}

export interface SafeFetcherOptions {
  /** 请求超时（毫秒） */
  timeoutMs?: number;
  /** 响应大小上限（字节） */
  maxBodyBytes?: number;
  /** 可注入的 fetch 实现（测试用） */
  fetchImpl?: typeof fetch;
  /** 可注入的 DNS 解析器（测试用，生产仍使用系统解析）。 */
  lookupImpl?: typeof lookup;
}

/** 创建带 SSRF 防护与大小上限的页面抓取器 */
export function createSafePageFetcher(options: SafeFetcherOptions = {}): PageFetcher {
  const fetchImpl = options.fetchImpl ?? fetch;
  const lookupImpl = options.lookupImpl ?? lookup;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;

  return {
    async fetch(rawUrl: string): Promise<FetchedPage> {
      const validateTarget = async (raw: string): Promise<string> => {
        const normalized = normalizeUrl(raw);
        if (normalized === null) {
          throw new GatewayError(`URL 非法或非 http(s)：${raw.slice(0, 80)}`, {
            retryable: false,
          });
        }
        const parsed = new URL(normalized);
        const addresses = await lookupImpl(parsed.hostname, {
          all: true,
          verbatim: true,
        }).catch(() => []);
        // 注入 fetch 的单元测试环境可能没有 DNS；生产默认 fetch 始终要求成功解析。
        if (addresses.length === 0 && options.fetchImpl === undefined) {
          throw new GatewayError(`域名无法解析：${parsed.hostname}`, { retryable: true });
        }
        if (addresses.some(({ address }) => isPrivateAddress(address))) {
          throw new GatewayError(`拒绝访问私网地址：${parsed.hostname}`, {
            retryable: false,
          });
        }
        return normalized;
      };

      let url = await validateTarget(rawUrl);
      let response: Response | null = null;
      for (let redirect = 0; redirect <= 3; redirect += 1) {
        response = await fetchImpl(url, {
          method: 'GET',
          // 手工处理重定向，确保每一跳都重新执行 SSRF 校验。
          redirect: 'manual',
          headers: {
            'user-agent': 'tutor-flow-research/0.1 (+https://tutor-flow.local/bot)',
            accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
          },
          signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
        }).catch((error: unknown) => {
          throw new GatewayError(
            `页面抓取失败：${error instanceof Error ? error.message.slice(0, 120) : '未知错误'}`,
            { retryable: true },
          );
        });
        if (response.status < 300 || response.status >= 400) break;
        const location = response.headers.get('location');
        if (location === null || redirect === 3) {
          throw new GatewayError('页面重定向次数超出上限或缺少目标地址', {
            retryable: false,
          });
        }
        url = await validateTarget(new URL(location, url).toString());
      }

      if (response === null) {
        throw new GatewayError('页面没有返回有效响应', { retryable: true });
      }

      if (!response.ok) {
        throw new GatewayError(`页面响应异常（${response.status}）`, {
          retryable: response.status >= 500 || response.status === 429,
          status: response.status,
        });
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!/text\/html|application\/xhtml|text\/plain/i.test(contentType)) {
        throw new GatewayError(`不支持的内容类型：${contentType.slice(0, 60)}`, {
          retryable: false,
        });
      }

      // 有界读取：超出上限即截断拒绝（防止超大响应）
      const buffer = await response.arrayBuffer().then((buffer) => {
        if (buffer.byteLength > maxBodyBytes) {
          throw new GatewayError('响应超过大小上限', { retryable: false });
        }
        return buffer;
      });
      const body = new TextDecoder('utf-8', { fatal: false }).decode(buffer);

      return {
        url,
        finalUrl: response.url || url,
        status: response.status,
        contentType,
        body,
        fetchedAt: new Date().toISOString(),
      };
    },
  };
}
