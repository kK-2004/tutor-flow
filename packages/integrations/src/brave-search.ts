/**
 * Brave Search 适配器。
 *
 * 重要约束（specs/research-provenance）：搜索摘要只作为召回元数据，
 * 抓取页面才是证据来源。本适配器返回的 snippet 永远不会进入文章内容。
 */
import {
  GatewayError,
  type SearchGateway,
  type SearchQuery,
  type SearchResultItem,
} from './gateway-types.js';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { SocksProxyAgent } from 'socks-proxy-agent';

/** Brave Web Search API 单条结果（仅映射需要的字段） */
interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
}

interface BraveResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

export interface BraveSearchOptions {
  /** API 访问令牌（由密钥提供器解析后传入，适配器不接触引用） */
  apiKey: string;
  /** API 端点（可指向测试桩） */
  endpoint?: string;
  /** 可注入的 fetch 实现（默认全局 fetch） */
  fetchImpl?: typeof fetch;
  /** 线上可选 SOCKS 代理地址；未配置时直接连接 */
  proxyUrl?: string;
  /** 单次请求超时（毫秒） */
  timeoutMs?: number;
  /** 相邻请求的最小间隔（毫秒），默认遵循 Brave Search 的 1 RPS 限制 */
  minRequestIntervalMs?: number;
}

const DEFAULT_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

interface SearchHttpResponse {
  body: string;
  status: number;
}

function requestThroughProxy(
  url: URL,
  apiKey: string,
  agent: SocksProxyAgent,
  timeoutMs: number,
): Promise<SearchHttpResponse> {
  const requester = url.protocol === 'http:' ? httpRequest : httpsRequest;
  return new Promise((resolve, reject) => {
    const request = requester(
      url,
      {
        agent,
        headers: {
          accept: 'application/json',
          'x-subscription-token': apiKey,
        },
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('end', () => {
          resolve({
            body: Buffer.concat(chunks).toString('utf8'),
            status: response.statusCode ?? 0,
          });
        });
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    request.end();
  });
}

/** 创建 Brave Search 网关 */
export function createBraveSearchGateway(options: BraveSearchOptions): SearchGateway {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const minRequestIntervalMs = options.minRequestIntervalMs ?? 1_000;
  const proxyAgent = options.proxyUrl ? new SocksProxyAgent(options.proxyUrl) : null;
  let nextRequestAt = 0;
  let requestSchedule: Promise<void> = Promise.resolve();

  const waitForRequestSlot = () => {
    const scheduled = requestSchedule.then(async () => {
      const waitMs = Math.max(0, nextRequestAt - Date.now());
      if (waitMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      }
      nextRequestAt = Date.now() + minRequestIntervalMs;
    });
    requestSchedule = scheduled.catch(() => undefined);
    return scheduled;
  };

  return {
    async search(query: SearchQuery): Promise<SearchResultItem[]> {
      await waitForRequestSlot();

      const url = new URL(endpoint);
      url.searchParams.set('q', query.query);
      url.searchParams.set('count', String(Math.min(query.maxResults, 20)));

      const response = await (
        proxyAgent
          ? requestThroughProxy(url, options.apiKey, proxyAgent, timeoutMs)
          : fetchImpl(url.toString(), {
              method: 'GET',
              headers: {
                accept: 'application/json',
                'x-subscription-token': options.apiKey,
              },
              signal: AbortSignal.timeout(timeoutMs),
            }).then(async (result) => ({
              body: await result.text(),
              status: result.status,
            }))
      ).catch((error: unknown) => {
        throw new GatewayError(
          `Brave Search 请求失败：${error instanceof Error ? error.message.slice(0, 120) : '未知错误'}`,
          { retryable: true },
        );
      });

      if (response.status === 429) {
        throw new GatewayError('Brave Search 限流（429）', {
          retryable: true,
          status: 429,
        });
      }
      if (response.status < 200 || response.status >= 300) {
        // 4xx 其他错误（配额耗尽/鉴权失败等）不自动重试
        throw new GatewayError(`Brave Search 请求失败（${response.status}）`, {
          retryable: response.status >= 500,
          status: response.status,
        });
      }

      let data: BraveResponse | null = null;
      try {
        data = JSON.parse(response.body) as BraveResponse;
      } catch {
        data = null;
      }
      const results = data?.web?.results ?? [];
      return results
        .filter(
          (item): item is BraveWebResult & { url: string } =>
            typeof item.url === 'string',
        )
        .map((item) => ({
          title: item.title ?? item.url,
          url: item.url,
          // 摘要仅用于召回展示；证据必须来自抓取页面
          snippet: item.description ?? '',
          publishedAt: item.age,
        }));
    },
  };
}
