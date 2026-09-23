/** 内容中心可在后台热更新的非敏感参数。 */
export interface ContentCenterSettings {
  source: 'minio';
  path: string;
  maxUploadBytes: number;
  downloadExpiresIn: number;
  cdnExpiresIn: number;
}

export const DEFAULT_CONTENT_CENTER_SETTINGS: ContentCenterSettings = {
  source: 'minio',
  path: 'tutor-flow',
  maxUploadBytes: 20 * 1024 * 1024,
  downloadExpiresIn: 300,
  cdnExpiresIn: 0,
};

/** 校验并冻结后台设置，避免危险路径或无效期限进入开放 API。 */
export function parseContentCenterSettings(value: unknown): ContentCenterSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('内容中心设置必须是对象');
  }
  const input = value as Record<string, unknown>;
  const path = input['path'];
  const maxUploadBytes = input['maxUploadBytes'];
  const downloadExpiresIn = input['downloadExpiresIn'];
  const cdnExpiresIn = input['cdnExpiresIn'];
  if (
    input['source'] !== 'minio' ||
    typeof path !== 'string' ||
    path.length < 1 ||
    path.length > 120 ||
    !path.split('/').every((segment) => /^[\p{L}\p{N}_-]+$/u.test(segment)) ||
    typeof maxUploadBytes !== 'number' ||
    !Number.isSafeInteger(maxUploadBytes) ||
    maxUploadBytes < 1 ||
    maxUploadBytes > 100 * 1024 * 1024 ||
    typeof downloadExpiresIn !== 'number' ||
    !Number.isInteger(downloadExpiresIn) ||
    downloadExpiresIn < 60 ||
    downloadExpiresIn > 3600 ||
    typeof cdnExpiresIn !== 'number' ||
    !Number.isInteger(cdnExpiresIn) ||
    (cdnExpiresIn !== 0 && (cdnExpiresIn < 60 || cdnExpiresIn > 3600))
  ) {
    throw new Error('内容中心设置范围无效');
  }
  return { source: 'minio', path, maxUploadBytes, downloadExpiresIn, cdnExpiresIn };
}
