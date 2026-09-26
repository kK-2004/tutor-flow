/**
 * k-File 内容中心开放 API 客户端。
 * 业务请求携带应用令牌，文件字节使用预签名地址从浏览器直传对象存储。
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

export interface ContentCenterDeleteResult {
  deletedFiles: number;
  failedObjects: number;
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

  const resolveFinalUrl = async (inputUrl: string): Promise<string> => {
    let current: URL;
    try {
      current = new URL(inputUrl);
    } catch {
      throw new ContentCenterError(-1, '内容中心返回的图片地址无效');
    }
    for (let redirectCount = 0; redirectCount <= 8; redirectCount += 1) {
      let response: Response;
      try {
        response = await fetcher(current, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new ContentCenterError(-1, '解析图片直链失败或超时');
      }
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        if (location === null) {
          throw new ContentCenterError(response.status, '图片跳转响应缺少地址');
        }
        try {
          current = new URL(location, current);
        } catch {
          throw new ContentCenterError(-1, '图片跳转地址无效');
        }
        if (!['http:', 'https:'].includes(current.protocol)) {
          throw new ContentCenterError(-1, '图片直链协议无效');
        }
        continue;
      }
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) {
        throw new ContentCenterError(response.status, '图片直链不可访问');
      }
      return current.toString();
    }
    throw new ContentCenterError(-1, '图片跳转次数过多');
  };

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

  const initUpload = async (
    filename: string,
    uploadOptions: ContentCenterUploadOptions = {},
  ): Promise<ContentCenterUploadInit> => {
    const raw = await post('/api/open/uploads', {
      originalName: filename,
      ...uploadOptions,
    });
    return {
      storageKey: requiredString(raw['storageKey'], 'storageKey'),
      source: requiredString(raw['source'], 'source'),
      putUrl: requiredString(raw['putUrl'], 'putUrl'),
      expiresIn: requiredNumber(raw['expiresIn'], 'expiresIn'),
      fileId: requiredNumber(raw['fileId'], 'fileId'),
    };
  };

  const completeUpload = async (
    storageKey: string,
    source: string,
  ): Promise<ContentCenterUploadResult> => {
    const raw = await post('/api/open/uploads/complete', { storageKey, source });
    return {
      fileId: requiredNumber(raw['fileId'], 'fileId'),
      name: requiredString(raw['name'], 'name'),
      size: requiredNumber(raw['size'], 'size'),
      contentType: requiredString(raw['contentType'], 'contentType'),
      storageKey,
      source,
    };
  };

  return {
    resolveFinalUrl,
    initUpload,
    completeUpload,
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
    async deleteFiles(fileIds: number[]): Promise<ContentCenterDeleteResult> {
      const raw = await post('/api/open/files/batch-delete', { fileIds });
      return {
        deletedFiles: requiredNumber(raw['deletedFiles'], 'deletedFiles'),
        failedObjects: requiredNumber(raw['failedObjects'], 'failedObjects'),
      };
    },
  };
}
