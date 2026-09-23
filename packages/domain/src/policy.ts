/**
 * 版本化策略与系统默认配置（非敏感）。
 *
 * 平台限制保存在版本化 PlatformPolicy 中，运行时可更新，
 * 不写死在提示词或界面里；批准与实际发布前都用最新生效策略重新校验。
 */

import type { PublishMode } from './run.js';

/** 小红书内容类型。首期只允许图文内容。 */
export const XIAOHONGSHU_CONTENT_TYPES = ['image_text'] as const;
export type XiaohongshuContentType = (typeof XIAOHONGSHU_CONTENT_TYPES)[number];

/** 小红书平台策略（版本化） */
export interface XiaohongshuPolicy {
  /** 策略版本标识，例如 `xhs-policy@2026.09` */
  policyVersion: string;
  title: {
    minLength: number;
    maxLength: number;
  };
  body: {
    minLength: number;
    maxLength: number;
  };
  tags: {
    minCount: number;
    maxCount: number;
  };
  media: {
    minCount: number;
    maxCount: number;
    /** 允许的媒体 MIME 类型 */
    allowedMimeTypes: string[];
    /** 是否要求封面（首图为封面） */
    requiresCover: boolean;
  };
  /** 当前策略允许的内容类型。 */
  contentTypes: XiaohongshuContentType[];
  /** 是否强制 AIGC 标识 */
  requiresAigcDisclosure: boolean;
  /** 当前策略允许的发布模式 */
  allowedPublishModes: PublishMode[];
  /** 审核模式默认值（首期固定 review，见设计文档） */
  defaultReviewMode: PublishMode;
}

/**
 * 校验并归一化外部存储的策略 JSON。
 *
 * 策略可能来自旧迁移或人工配置，因此这里提供兼容默认值，
 * 同时拒绝会关闭安全门槛的非法范围。
 */
export function parseXiaohongshuPolicy(input: unknown): XiaohongshuPolicy {
  if (typeof input !== 'object' || input === null) {
    throw new Error('小红书策略必须是对象');
  }
  const value = input as Record<string, unknown>;
  const version = value['policyVersion'];
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error('小红书策略缺少版本');
  }

  const section = (name: string): Record<string, unknown> => {
    const item = value[name];
    return typeof item === 'object' && item !== null
      ? (item as Record<string, unknown>)
      : {};
  };
  const numberField = (
    group: Record<string, unknown>,
    name: string,
    fallback: number,
  ): number => {
    const item = group[name];
    return typeof item === 'number' && Number.isFinite(item) ? item : fallback;
  };
  const title = section('title');
  const body = section('body');
  const tags = section('tags');
  const media = section('media');
  const titleMin = numberField(title, 'minLength', 2);
  const titleMax = numberField(title, 'maxLength', 20);
  const bodyMin = numberField(body, 'minLength', 10);
  const bodyMax = numberField(body, 'maxLength', 1000);
  const tagsMin = numberField(tags, 'minCount', 1);
  const tagsMax = numberField(tags, 'maxCount', 10);
  const mediaMin = numberField(media, 'minCount', 1);
  const mediaMax = numberField(media, 'maxCount', 18);
  const allowedMimeTypes = Array.isArray(media['allowedMimeTypes'])
    ? media['allowedMimeTypes'].filter((item): item is string => typeof item === 'string')
    : ['image/jpeg', 'image/png', 'image/webp'];
  const allowedPublishModes: PublishMode[] = Array.isArray(value['allowedPublishModes'])
    ? value['allowedPublishModes'].filter(
        (item): item is PublishMode => item === 'review' || item === 'auto',
      )
    : ['review', 'auto'];
  const contentTypes: XiaohongshuContentType[] = Array.isArray(value['contentTypes'])
    ? value['contentTypes'].filter(
        (item): item is XiaohongshuContentType => item === 'image_text',
      )
    : ['image_text'];
  if (
    titleMin < 1 ||
    titleMax < titleMin ||
    bodyMin < 1 ||
    bodyMax < bodyMin ||
    tagsMin < 0 ||
    tagsMax < tagsMin ||
    mediaMin < 0 ||
    mediaMax < mediaMin ||
    allowedMimeTypes.length === 0 ||
    allowedPublishModes.length === 0 ||
    contentTypes.length === 0
  ) {
    throw new Error('小红书策略范围无效');
  }
  const defaultReviewMode = value['defaultReviewMode'] === 'auto' ? 'auto' : 'review';
  const requiresAigcDisclosure = value['requiresAigcDisclosure'] !== false;
  return {
    policyVersion: version,
    title: { minLength: titleMin, maxLength: titleMax },
    body: { minLength: bodyMin, maxLength: bodyMax },
    tags: { minCount: tagsMin, maxCount: tagsMax },
    media: {
      minCount: mediaMin,
      maxCount: mediaMax,
      allowedMimeTypes,
      requiresCover: media['requiresCover'] !== false,
    },
    contentTypes,
    requiresAigcDisclosure,
    allowedPublishModes,
    defaultReviewMode,
  };
}

/**
 * 默认小红书策略（保守初值，来自当前已验证的适配器能力）。
 * 上线时以实测能力修订并升版本，不修改此常量语义。
 */
export const DEFAULT_XIAOHONGSHU_POLICY: XiaohongshuPolicy = {
  policyVersion: 'xhs-policy@2026.09',
  title: { minLength: 2, maxLength: 20 },
  body: { minLength: 10, maxLength: 1000 },
  tags: { minCount: 1, maxCount: 10 },
  media: {
    minCount: 1,
    maxCount: 18,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    requiresCover: true,
  },
  contentTypes: ['image_text'],
  requiresAigcDisclosure: true,
  allowedPublishModes: ['review', 'auto'],
  defaultReviewMode: 'review',
};

/** 质量门槛（方向自动选向与发布前的统一依据） */
export interface QualityThresholds {
  /** 事实来源覆盖率下限（0-1） */
  minSourceCoverage: number;
  /** 主要来源数量下限 */
  minPrimarySources: number;
  /** 方向总分下限（0-100） */
  minDirectionScore: number;
  /** 合规风险上限（0-1） */
  maxRisk: number;
  /** 单条来源最低总分 */
  minSourceTotalScore: number;
}

/** 默认质量门槛（首期保守值，可通过系统设置调整） */
export const DEFAULT_QUALITY_THRESHOLDS: QualityThresholds = {
  minSourceCoverage: 0.9,
  minPrimarySources: 1,
  minDirectionScore: 60,
  maxRisk: 0.3,
  minSourceTotalScore: 40,
};

/** 搜索预算：控制外部搜索与抓取规模 */
export interface SearchBudget {
  /** 查询计划生成的最大查询数 */
  maxQueries: number;
  /** 每条查询的最大结果数 */
  maxResultsPerQuery: number;
  /** 单次运行最大抓取页面数 */
  maxFetches: number;
}

/** 默认搜索预算 */
export const DEFAULT_SEARCH_BUDGET: SearchBudget = {
  maxQueries: 5,
  maxResultsPerQuery: 10,
  maxFetches: 20,
};

/** 来源评分因子权重（合计 1） */
export interface SourceScoreWeights {
  authority: number;
  relevance: number;
  originality: number;
  timeliness: number;
  corroboration: number;
  languageFit: number;
}

/** 默认来源评分权重：权威与原创优先，语言契合但不牺牲权威原始来源 */
export const DEFAULT_SOURCE_SCORE_WEIGHTS: SourceScoreWeights = {
  authority: 0.3,
  relevance: 0.25,
  originality: 0.2,
  timeliness: 0.1,
  corroboration: 0.1,
  languageFit: 0.05,
};
