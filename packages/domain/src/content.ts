/**
 * 内容制品与草稿领域类型。
 *
 * 内容模型采用一份 CANONICAL 制品与一份 XIAOHONGSHU 衍生稿；
 * 平台适配只改变表达、标签与媒体编排，不重新检索或发明事实。
 */

import type { ClaimUsageLocation } from './research.js';

/** 内容中心媒体：草稿保存稳定文件标识，不持久化可能过期的 CDN 地址。 */
export interface ContentCenterMedia {
  fileId: number;
  name: string;
  contentType: string;
}

/** 兼容已有草稿中的对象键；新上传文件使用内容中心元数据。 */
export type DraftMedia = string | ContentCenterMedia;

/** 内容制品种类全集（数据库枚举共用） */
export const CONTENT_ARTIFACT_KINDS = ['CANONICAL', 'XIAOHONGSHU'] as const;

/** 内容制品种类 */
export type ContentArtifactKind = (typeof CONTENT_ARTIFACT_KINDS)[number];

/** 生成元数据：模型、提示词与来源链路的审计快照 */
export interface GenerationMetadata {
  provider: string;
  model: string;
  promptVersion: string;
  generatedAt: string;
  /** 生成时的输入来源摘要（来源 id 列表） */
  sourceIds: string[];
  tokenUsage: {
    promptTokens: number;
    completionTokens: number;
  };
}

/** 内容制品 */
export interface ContentArtifact {
  id: string;
  runId: string;
  kind: ContentArtifactKind;
  version: number;
  /** 正文（Markdown/受控 HTML） */
  body: string;
  title?: string;
  tags: string[];
  /** 媒体引用（对象存储键，有序） */
  mediaObjectKeys: string[];
  /** 事实使用位置：制品内每个事实性陈述的来源关联 */
  claimUsages: ClaimUsageLocation[];
  generation?: GenerationMetadata;
  /** 是否 AI 生成或实质性 AI 改写 */
  aiGenerated: boolean;
  /** 显式 AIGC 标识状态 */
  aigcDisclosure: AigcDisclosureStatus;
  /** 人工审核状态 */
  humanReview: HumanReviewStatus;
}

/** AIGC 标识状态全集（数据库枚举共用） */
export const AIGC_DISCLOSURE_STATUSES = [
  'disclosed',
  'undisclosed',
  'not_required',
] as const;

/** AIGC 标识状态 */
export type AigcDisclosureStatus = (typeof AIGC_DISCLOSURE_STATUSES)[number];

/** 人工审核状态全集（数据库枚举共用） */
export const HUMAN_REVIEW_STATUSES = [
  'not_reviewed',
  'approved',
  'rejected',
  'edited_after_approval',
] as const;

/** 人工审核状态 */
export type HumanReviewStatus = (typeof HUMAN_REVIEW_STATUSES)[number];

/** 草稿状态全集（数据库枚举共用） */
export const DRAFT_STATUSES = [
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED',
  'SUPERSEDED',
] as const;

/** 草稿状态 */
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

/** 草稿（待审核的小红书制品容器） */
export interface Draft {
  id: string;
  runId: string;
  /** 当前修订版本号（乐观并发控制） */
  revision: number;
  status: DraftStatus;
  /** 当前修订内容 */
  artifact: ContentArtifact;
  /** 批准信息（批准时快照策略版本与操作主体） */
  approval?: {
    approvedBy: string;
    approvedAt: string;
    policyVersion: string;
    publishJobId?: string;
  };
  createdAt: string;
  updatedAt: string;
}

/** 内容校验结果（字段级，供预览与批准操作使用） */
export interface ContentValidationIssue {
  /** 字段路径或策略规则标识 */
  field: string;
  severity: 'error' | 'warning';
  message: string;
}
