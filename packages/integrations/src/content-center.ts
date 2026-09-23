/**
 * k-File 内容中心开放 API 客户端。
 * 业务请求携带应用令牌，文件字节使用预签名地址直传对象存储。
 */
export class ContentCenterError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ContentCenterError';
  }
}

export interface ContentCenterUploadInit {
  storageKey: string;
  source: string;
  putUrl: string;
  expiresIn: number;
  fileId: number;
}

export interface ContentCenterUploadResult {
  fileId: number;
  name: string;
  size: number;
  contentType: string;
  storageKey: string;
  source: string;
}

export interface ContentCenterLink {
  url: string;
  expiresIn: number;
}

export interface ContentCenterCdnLink extends ContentCenterLink {
  permanent: boolean;
  contentType: string;
}

export interface ContentCenterUploadOptions {
  source?: string;
  path?: string;
  contentType?: string;
  size?: number;
}

export interface ContentCenterClientOptions {
  baseUrl: string;
  appToken: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContentCenterError(-1, '内容中心响应格式异常');
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ContentCenterError(-1, `内容中心响应缺少 ${field}`);
  }
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ContentCenterError(-1, `内容中心响应缺少 ${field}`);
  }
  return value;
}

export function createContentCenterClient(options: ContentCenterClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(baseUrl) || options.appToken.trim() === '') {
    throw new Error('内容中心地址或应用令牌未配置');
  }
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;

  const post = async (
    path: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    let response: Response;
    try {
      response = await fetcher(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.appToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new ContentCenterError(-1, '内容中心连接失败或超时');
    }
    let payload: Record<string, unknown>;
    try {
      payload = record(await response.json());
    } catch {
      throw new ContentCenterError(response.status, '内容中心响应不可解析');
    }
    if (!response.ok) {
      const message =
        typeof payload['message'] === 'string' ? payload['message'] : '请求失败';
      throw new ContentCenterError(response.status, message.slice(0, 200));
    }
    return payload;
  };

  return {
    async initUpload(
      filename: string,
      options: ContentCenterUploadOptions = {},
    ): Promise<ContentCenterUploadInit> {
      const raw = await post('/api/open/uploads', {
        originalName: filename,
        ...options,
      });
      return {
        storageKey: requiredString(raw['storageKey'], 'storageKey'),
        source: requiredString(raw['source'], 'source'),
        putUrl: requiredString(raw['putUrl'], 'putUrl'),
        expiresIn: requiredNumber(raw['expiresIn'], 'expiresIn'),
        fileId: requiredNumber(raw['fileId'], 'fileId'),
      };
    },
    async completeUpload(
      storageKey: string,
      source: string,
    ): Promise<ContentCenterUploadResult> {
      const raw = await post('/api/open/uploads/complete', { storageKey, source });
      return {
        fileId: requiredNumber(raw['fileId'], 'fileId'),
        name: requiredString(raw['name'], 'name'),
        size: requiredNumber(raw['size'], 'size'),
        contentType: requiredString(raw['contentType'], 'contentType'),
        storageKey,
        source,
      };
    },
    async getDownloadLink(
      fileId: number,
      expiresIn?: number,
    ): Promise<ContentCenterLink> {
      const raw = await post('/api/open/download-links', { fileId, expiresIn });
      return {
        url: requiredString(raw['url'], 'url'),
        expiresIn: requiredNumber(raw['expiresIn'], 'expiresIn'),
      };
    },
    async getCdnLink(fileId: number, expiresIn?: number): Promise<ContentCenterCdnLink> {
      const raw = await post('/api/open/cdn-links', { fileId, expiresIn });
      return {
        url: requiredString(raw['url'], 'url'),
        expiresIn: requiredNumber(raw['expiresIn'], 'expiresIn'),
        permanent: raw['permanent'] === true,
        contentType: requiredString(raw['contentType'], 'contentType'),
      };
    },
  };
}
