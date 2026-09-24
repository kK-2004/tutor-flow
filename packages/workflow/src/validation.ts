/**
 * 内容校验模块：审核、预览与批准共用的统一规则。
 *
 * 规则来源：版本化平台策略（标题/正文/标签/媒体/AIGC）+
 * 内容安全（隐私、敏感词）+ 事实来源覆盖（claim_usage 绑定）。
 * 返回字段级可操作问题列表，供 API 与处理器消费。
 */
import type { ContentValidationIssue, DraftMedia } from '@tutor-flow/domain';
import type {
  XiaohongshuPolicy,
  PublishMode,
  XiaohongshuContentType,
} from '@tutor-flow/domain';

/** 待校验的小红书内容（草稿修订形态） */
export interface XhsContentInput {
  title: string;
  body: string;
  tags: string[];
  mediaObjectKeys: DraftMedia[];
  aigcDisclosure: string;
  /** 事实引用（claimId 列表，重复忽略） */
  claimUsages: Array<{ claimId: string }>;
  /** 内容类型，首期固定为图文。 */
  contentType?: XiaohongshuContentType;
  /** 发布审核模式，用于策略门禁。 */
  publishMode?: PublishMode;
}

/** 每条事实是否实际存在且有来源支持（由调用方查询后传入） */
export interface ClaimSupportEntry {
  claimId: string;
  hasSource: boolean;
}

/** 隐私检测模式：手机号、身份证、邮箱 */
const PRIVACY_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: '手机号', pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  { name: '身份证号', pattern: /(?<!\d)\d{17}[\dXx](?!\d)/ },
  { name: '邮箱地址', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
];

/** 敏感词表（首期最小集，可纳入策略配置扩展） */
const SENSITIVE_WORDS = ['最便宜', '国家级', '绝对有效', '包治', '内部渠道'];

/** 媒体对象键的扩展名（匹配策略允许的 MIME 类型） */
function mediaExtension(key: string): string {
  const match = /\.([a-zA-Z0-9]+)$/.exec(key);
  const ext = match?.[1]?.toLowerCase();
  if (ext === undefined) {
    return '';
  }
  return ext === 'jpg' ? 'jpeg' : ext;
}

/** 新媒体按内容中心返回的 MIME 校验；旧对象键保留扩展名兼容。 */
function isAllowedMedia(media: DraftMedia, allowedMimeTypes: readonly string[]): boolean {
  if (typeof media === 'string') {
    const extension = mediaExtension(media);
    return (
      extension !== '' &&
      allowedMimeTypes.some((mime) => mime.toLowerCase().endsWith(extension))
    );
  }
  return (
    Number.isSafeInteger(media.fileId) &&
    media.fileId > 0 &&
    media.name.length > 0 &&
    allowedMimeTypes.some(
      (mime) => mime.toLowerCase() === media.contentType.toLowerCase(),
    )
  );
}

/** 校验小红书内容，返回全部问题（error 阻断审核/发布，warning 仅提示） */
export function validateXhsContent(
  content: XhsContentInput,
  policy: XiaohongshuPolicy,
  claimSupport: readonly ClaimSupportEntry[],
): ContentValidationIssue[] {
  const issues: ContentValidationIssue[] = [];

  // ---- 标题 ----
  const titleLen = [...content.title].length;
  if (titleLen < policy.title.minLength) {
    issues.push({
      field: 'title',
      severity: 'error',
      message: `标题至少 ${policy.title.minLength} 个字符（当前 ${titleLen}）`,
    });
  } else if (titleLen > policy.title.maxLength) {
    issues.push({
      field: 'title',
      severity: 'error',
      message: `标题最多 ${policy.title.maxLength} 个字符（当前 ${titleLen}）`,
    });
  }

  // ---- 正文 ----
  const bodyLen = [...content.body].length;
  if (bodyLen < policy.body.minLength) {
    issues.push({
      field: 'body',
      severity: 'error',
      message: `正文至少 ${policy.body.minLength} 个字符（当前 ${bodyLen}）`,
    });
  } else if (bodyLen > policy.body.maxLength) {
    issues.push({
      field: 'body',
      severity: 'error',
      message: `正文最多 ${policy.body.maxLength} 个字符（当前 ${bodyLen}）`,
    });
  }

  // ---- 标签 ----
  if (content.tags.length < policy.tags.minCount) {
    issues.push({
      field: 'tags',
      severity: 'error',
      message: `至少需要 ${policy.tags.minCount} 个标签（当前 ${content.tags.length}）`,
    });
  } else if (content.tags.length > policy.tags.maxCount) {
    issues.push({
      field: 'tags',
      severity: 'error',
      message: `标签最多 ${policy.tags.maxCount} 个（当前 ${content.tags.length}）`,
    });
  }

  // ---- 媒体 ----
  if (content.mediaObjectKeys.length > policy.media.maxCount) {
    issues.push({
      field: 'media',
      severity: 'error',
      message: `媒体最多 ${policy.media.maxCount} 张（当前 ${content.mediaObjectKeys.length}）`,
    });
  }
  if (
    content.mediaObjectKeys.some(
      (media) => !isAllowedMedia(media, policy.media.allowedMimeTypes),
    )
  ) {
    issues.push({
      field: 'media.format',
      severity: 'error',
      message: `媒体格式不在策略允许范围内：${policy.media.allowedMimeTypes.join('、')}`,
    });
  }
  if (policy.media.requiresCover && content.mediaObjectKeys.length > 0) {
    const cover = content.mediaObjectKeys[0];
    const coverAllowed =
      cover !== undefined && isAllowedMedia(cover, policy.media.allowedMimeTypes);
    if (!coverAllowed) {
      issues.push({
        field: 'media.cover',
        severity: 'error',
        message: '封面格式不符合策略要求',
      });
    }
  }

  // ---- AIGC 标识 ----
  if (policy.requiresAigcDisclosure && content.aigcDisclosure !== 'disclosed') {
    issues.push({
      field: 'aigc',
      severity: 'error',
      message: '当前策略要求 AIGC 标识，内容缺少标识',
    });
  }

  // ---- 内容类型与审核模式 ----
  if (
    content.contentType !== undefined &&
    !policy.contentTypes.includes(content.contentType)
  ) {
    issues.push({
      field: 'contentType',
      severity: 'error',
      message: `内容类型 ${content.contentType} 不在当前策略允许范围内`,
    });
  }
  if (
    content.publishMode !== undefined &&
    !policy.allowedPublishModes.includes(content.publishMode)
  ) {
    issues.push({
      field: 'publishMode',
      severity: 'error',
      message: `发布模式 ${content.publishMode} 不在当前策略允许范围内`,
    });
  }

  // ---- 事实来源覆盖 ----
  const supportMap = new Map(
    claimSupport.map((entry) => [entry.claimId, entry.hasSource]),
  );
  const uniqueClaimIds = [...new Set(content.claimUsages.map((usage) => usage.claimId))];
  if (uniqueClaimIds.length === 0) {
    issues.push({
      field: 'claims',
      severity: 'error',
      message: '内容未引用任何已核验事实，不得发布',
    });
  }
  for (const claimId of uniqueClaimIds) {
    const hasSource = supportMap.get(claimId);
    if (hasSource === undefined) {
      issues.push({
        field: 'claims',
        severity: 'error',
        message: `引用的事实不存在：${claimId.slice(0, 8)}…`,
      });
    } else if (!hasSource) {
      issues.push({
        field: 'claims',
        severity: 'error',
        message: `引用的事实缺少来源支持：${claimId.slice(0, 8)}…`,
      });
    }
  }

  // ---- 隐私 ----
  for (const { name, pattern } of PRIVACY_PATTERNS) {
    if (pattern.test(content.body) || pattern.test(content.title)) {
      issues.push({
        field: 'privacy',
        severity: 'error',
        message: `检测到${name}，请移除隐私信息`,
      });
    }
  }

  // ---- 敏感词 ----
  for (const word of SENSITIVE_WORDS) {
    if (content.body.includes(word)) {
      issues.push({
        field: 'sensitive',
        severity: 'error',
        message: `包含敏感词：「${word}」`,
      });
    }
  }

  return issues;
}

/** 是否存在阻断级问题 */
export function hasBlockingIssues(issues: readonly ContentValidationIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}
