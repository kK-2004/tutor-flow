/**
 * 确定性模拟实现：集成测试专用。
 *
 * 全部行为可脚本化（固定返回、可注入故障），不依赖外部网络；
 * 覆盖规格要求的场景：搜索部分失败、权威非中文来源、转载页面等。
 */
import { createHash } from 'node:crypto';

import type {
  ContentExtractor,
  ExtractedContent,
  FetchedPage,
  LlmGateway,
  LlmRequest,
  LlmResponse,
  ObjectStorage,
  PageFetcher,
  SearchGateway,
  SearchQuery,
  SearchResultItem,
  VectorService,
} from './gateway-types.js';

/** 搜索网关模拟：按关键词脚本返回；可注入失败查询 */
export class FakeSearchGateway implements SearchGateway {
  private readonly scripted: Array<{
    match: (query: SearchQuery) => boolean;
    results: SearchResultItem[] | Error;
  }> = [];
  /** 调用记录（断言用） */
  readonly calls: SearchQuery[] = [];

  on(match: (query: SearchQuery) => boolean, results: SearchResultItem[] | Error): this {
    this.scripted.push({ match, results });
    return this;
  }

  async search(query: SearchQuery): Promise<SearchResultItem[]> {
    this.calls.push(query);
    // 后注册的脚本优先（便于用例覆盖先前的脚本）
    for (const entry of [...this.scripted].reverse()) {
      if (entry.match(query)) {
        if (entry.results instanceof Error) {
          throw entry.results;
        }
        return entry.results;
      }
    }
    return [];
  }
}

/** 页面抓取器模拟：按 URL 脚本返回；可注入失败 */
export class FakePageFetcher implements PageFetcher {
  private readonly scripted = new Map<string, { page: Partial<FetchedPage> } | Error>();
  readonly calls: string[] = [];

  on(url: string, page: Partial<FetchedPage> | Error): this {
    this.scripted.set(url, page instanceof Error ? page : { page });
    return this;
  }

  async fetch(url: string): Promise<FetchedPage> {
    this.calls.push(url);
    const entry = this.scripted.get(url);
    if (entry instanceof Error) {
      throw entry;
    }
    const page = entry?.page ?? {};
    return {
      url,
      finalUrl: page.finalUrl ?? url,
      status: page.status ?? 200,
      contentType: page.contentType ?? 'text/html; charset=utf-8',
      body:
        page.body ??
        `<html><head><title>${url}</title></head><body><p>${url}</p></body></html>`,
      fetchedAt: page.fetchedAt ?? new Date().toISOString(),
    };
  }
}

/** 正文提取器模拟：剥离简单 HTML 标签（确定性、无依赖） */
export class FakeContentExtractor implements ContentExtractor {
  extract(page: FetchedPage): ExtractedContent {
    const titleMatch = /<title>([^<]*)<\/title>/i.exec(page.body);
    const text = page.body
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      canonicalUrl: page.finalUrl,
      title: titleMatch?.[1]?.trim() ?? page.finalUrl,
      text,
      language: 'zh',
    };
  }
}

/** 向量服务模拟：基于字符 bigram 哈希的确定性向量 */
export class FakeVectorService implements VectorService {
  private readonly dimensions = 64;

  async embed(text: string): Promise<number[]> {
    const vector = new Array<number>(this.dimensions).fill(0);
    const normalized = text.toLowerCase().replace(/\s+/g, '');
    for (let i = 0; i < normalized.length - 1; i++) {
      const bigram = normalized.slice(i, i + 2);
      const hash = createHash('md5').update(bigram).digest();
      const first = hash[0] ?? 0;
      const second = hash[1] ?? 0;
      const index = first % this.dimensions;
      const sign = second % 2 === 0 ? 1 : -1;
      vector[index] = (vector[index] ?? 0) + sign;
    }
    // 归一化
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vector.map((v) => v / norm);
  }

  similarity(a: number[], b: number[]): number {
    let dot = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      dot += (a[i] ?? 0) * (b[i] ?? 0);
    }
    return dot;
  }
}

/** LLM 网关模拟：按任务与关键词脚本返回；记录调用供用量审计 */
export class FakeLlmGateway implements LlmGateway {
  private readonly scripted: Array<{
    match: (request: LlmRequest) => boolean;
    respond: (request: LlmRequest) => string | Error;
  }> = [];
  readonly calls: LlmRequest[] = [];

  on(
    match: (request: LlmRequest) => boolean,
    respond: (request: LlmRequest) => string | Error,
  ): this {
    this.scripted.push({ match, respond });
    return this;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.calls.push(request);
    // 后注册的脚本优先（便于用例覆盖先前的脚本）
    for (const entry of [...this.scripted].reverse()) {
      if (entry.match(request)) {
        const text = entry.respond(request);
        if (text instanceof Error) {
          throw text;
        }
        return {
          text,
          provider: 'fake',
          model: 'fake-model-1',
          usage: {
            promptTokens: Math.ceil(request.systemPrompt.length / 4),
            completionTokens: Math.ceil(text.length / 4),
          },
        };
      }
    }
    return {
      text: '',
      provider: 'fake',
      model: 'fake-model-1',
      usage: { promptTokens: 0, completionTokens: 0 },
    };
  }
}

/** 对象存储模拟：内存 Map（键存在性、读取均确定） */
export class FakeObjectStorage implements ObjectStorage {
  private readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType });
  }

  async getObject(key: string): Promise<Buffer> {
    const object = this.objects.get(key);
    if (object === undefined) {
      throw new Error(`对象不存在：${key}`);
    }
    return object.body;
  }

  async hasObject(key: string): Promise<boolean> {
    return this.objects.has(key);
  }
}
