/**
 * 外部网关接口契约。
 *
 * 领域代码只依赖这些接口，不依赖具体供应商；
 * 测试使用 fakes.ts 中的确定性模拟实现。
 */

/** 搜索查询（召回用途） */
export interface SearchQuery {
  query: string;
  language: string;
  intent: string;
  maxResults: number;
}

/** 搜索结果：仅作召回元数据，抓取页面才是证据来源 */
export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

/** 搜索网关 */
export interface SearchGateway {
  search(query: SearchQuery): Promise<SearchResultItem[]>;
}

/** 网关调用失败：携带可重试性标记（限流/5xx 可重试，其余不自动重试） */
export class GatewayError extends Error {
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, options?: { retryable?: boolean; status?: number }) {
    super(message);
    this.name = 'GatewayError';
    this.retryable = options?.retryable ?? false;
    this.status = options?.status;
  }
}

/** 抓取到的原始页面（不可信数据） */
export interface FetchedPage {
  /** 请求 URL */
  url: string;
  /** 重定向后的最终 URL */
  finalUrl: string;
  /** HTTP 状态码 */
  status: number;
  contentType: string;
  /** 原始 HTML */
  body: string;
  fetchedAt: string;
}

/** 页面抓取器 */
export interface PageFetcher {
  fetch(url: string): Promise<FetchedPage>;
}

/** 提取后的规范正文 */
export interface ExtractedContent {
  canonicalUrl: string;
  title: string;
  text: string;
  language: string;
  publishedAt?: string;
}

/** 正文提取器 */
export interface ContentExtractor {
  extract(page: FetchedPage): ExtractedContent;
}

/** LLM 调用请求 */
export interface LlmRequest {
  /** 任务标识（如 query_planning、canonical_article） */
  task: string;
  /** 提示词版本（审计用） */
  promptVersion: string;
  systemPrompt: string;
  userPrompt: string;
  /** 随用户提示词发送的图片，URL 必须是调用时换取的直链。 */
  images?: Array<{
    url: string;
    mediaType: string;
    detail: 'low' | 'high' | 'auto';
  }>;
  maxTokens: number;
  /** 结构化输出的本地校验及供应商约束 */
  outputSchema?: import('zod').ZodType;
  outputName?: string;
}

/** LLM 调用响应 */
export interface LlmResponse {
  text: string;
  provider: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
  };
}

/** LLM 网关 */
export interface LlmGateway {
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/** 向量服务：语义去重使用 */
export interface VectorService {
  /** 生成文本向量（归一化） */
  embed(text: string): Promise<number[]>;
  /** 余弦相似度 */
  similarity(a: number[], b: number[]): number;
}

/** 对象存储：大文本与媒体文件 */
export interface ObjectStorage {
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  getObject(key: string): Promise<Buffer>;
  /** 对象是否存在（幂等写入与审计校验用） */
  hasObject(key: string): Promise<boolean>;
}
