/**
 * 研究与来源链路表（SQLite）：查询计划、来源文档、重复聚类、
 * 事实、事实来源关联、候选方向、内容制品。
 *
 * 约定：网页正文仅供模型即时使用，用完即弃，不持久化（用户决策）；
 * 库内只保存来源元数据与内容哈希；来源记录永不物理删除
 * （去重只做聚类标记）。
 */
import { randomUUID } from 'node:crypto';

import {
  AIGC_DISCLOSURE_STATUSES,
  CONTENT_ARTIFACT_KINDS,
  HUMAN_REVIEW_STATUSES,
  SOURCE_CLUSTER_ROLES,
  SOURCE_FETCH_STATUSES,
  SOURCE_TYPES,
} from '@tutor-flow/domain';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

import { workflowRuns } from './workflow.js';

const uuidPk = () =>
  text()
    .primaryKey()
    .$defaultFn(() => randomUUID());

const timestampMs = () => integer({ mode: 'timestamp_ms' });

const now = () =>
  timestampMs()
    .notNull()
    .$defaultFn(() => new Date());

/** 用户维护的 Markdown 研究资料目录。 */
export const researchFolders = sqliteTable('research_folder', {
  id: uuidPk(),
  name: text().notNull(),
  parentId: text(),
  createdAt: now(),
});

/** 用户维护的 Markdown 研究资料。 */
export const researchDocuments = sqliteTable('research_document', {
  id: uuidPk(),
  folderId: text().references(() => researchFolders.id, { onDelete: 'set null' }),
  title: text().notNull(),
  markdown: text().notNull(),
  createdAt: now(),
  updatedAt: now(),
});

// ---------- 枚举列 ----------

/** 来源类型列 */
export const sourceTypeColumn = () => text({ enum: SOURCE_TYPES });
/** 来源抓取状态列 */
export const sourceFetchStatusColumn = () => text({ enum: SOURCE_FETCH_STATUSES });
/** 聚类角色列 */
export const sourceClusterRoleColumn = () => text({ enum: SOURCE_CLUSTER_ROLES });
/** 聚类判定方法列 */
export const duplicateMethodColumn = () =>
  text({ enum: ['URL', 'TEXT_FINGERPRINT', 'SEMANTIC'] });
/** 内容制品种类列 */
export const contentArtifactKindColumn = () => text({ enum: CONTENT_ARTIFACT_KINDS });
/** AIGC 标识状态列 */
export const aigcDisclosureColumn = () => text({ enum: AIGC_DISCLOSURE_STATUSES });
/** 人工审核状态列 */
export const humanReviewColumn = () => text({ enum: HUMAN_REVIEW_STATUSES });

// ---------- 查询计划 ----------

/** 查询计划：研究步骤生成的结构化查询与用量记录 */
export const queryPlans = sqliteTable(
  'query_plan',
  {
    id: uuidPk(),
    runId: text()
      .notNull()
      .references(() => workflowRuns.id),
    /** 查询数组：{ query, language, intent } 有序列表 */
    queries: text({ mode: 'json' }).notNull(),
    /** 生成查询的模型别名 */
    model: text().notNull(),
    promptVersion: text().notNull(),
    /** 用量计量：{ promptTokens, completionTokens } */
    usage: text({ mode: 'json' }).notNull(),
    /** 部分失败记录：失败的查询及其原因（不含敏感信息） */
    partialFailures: text({ mode: 'json' }),
    createdAt: now(),
  },
  (t) => [index('query_plan_run_idx').on(t.runId)],
);

// ---------- 重复聚类 ----------

/**
 * 重复聚类：同一运行内相似来源的分组。
 * canonical_source_id 允许先空后填，避免来源与聚类的循环插入依赖。
 */
export const duplicateClusters = sqliteTable(
  'duplicate_cluster',
  {
    id: uuidPk(),
    runId: text()
      .notNull()
      .references(() => workflowRuns.id),
    /** 聚类内被认定为规范来源的文档（回填） */
    canonicalSourceId: text(),
    /** 主要判定方法 */
    method: duplicateMethodColumn().notNull(),
    /** 判定相似度（0-1） */
    similarity: real(),
    createdAt: now(),
  },
  (t) => [index('duplicate_cluster_run_idx').on(t.runId)],
);

// ---------- 来源文档 ----------

/** 归一化来源文档：搜索摘要之外的抓取证据来源 */
export const sourceDocuments = sqliteTable(
  'source_document',
  {
    id: uuidPk(),
    runId: text()
      .notNull()
      .references(() => workflowRuns.id),
    /** 规范化后的 URL */
    canonicalUrl: text().notNull(),
    /** 规范 URL 哈希（运行内唯一） */
    urlHash: text().notNull(),
    title: text().notNull(),
    domain: text().notNull(),
    language: text().notNull(),
    sourceType: sourceTypeColumn().notNull().default('OTHER'),
    fetchStatus: sourceFetchStatusColumn().notNull().default('PENDING'),
    /** 抓取失败/被拦截时的脱敏说明 */
    fetchNote: text(),
    /** 正文内容哈希（SHA-256 十六进制；正文本身用完即弃，不持久化） */
    contentHash: text(),
    /** 来源发布时间（ISO 8601 字符串，精度受限时保留原文） */
    publishedAt: text(),
    fetchedAt: timestampMs(),
    /** 是否为主要来源（官方文档、原始出处） */
    isPrimary: integer({ mode: 'boolean' }).notNull().default(false),
    clusterId: text().references(() => duplicateClusters.id),
    clusterRole: sourceClusterRoleColumn(),
    /** 各评分因子得分 */
    scoreFactors: text({ mode: 'json' }),
    totalScore: real(),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex('source_document_run_url_unique').on(t.runId, t.urlHash),
    index('source_document_cluster_idx').on(t.clusterId),
    index('source_document_run_idx').on(t.runId),
  ],
);

// ---------- 事实 ----------

/** 事实（claim）：带来源绑定与置信度的核验陈述 */
export const claims = sqliteTable(
  'claim',
  {
    id: uuidPk(),
    runId: text()
      .notNull()
      .references(() => workflowRuns.id),
    statement: text().notNull(),
    confidence: real().notNull(),
    /** 是否有主要来源支持 */
    primarySourceSupported: integer({ mode: 'boolean' }).notNull().default(false),
    verifiedAt: timestampMs(),
    /** 内容使用位置：[{ artifactKind, locator }] */
    usedIn: text({ mode: 'json' }),
    createdAt: now(),
  },
  (t) => [index('claim_run_idx').on(t.runId)],
);

/** 事实-来源关联：多对多强绑定（无来源事实不允许自动发布） */
export const claimSources = sqliteTable(
  'claim_source',
  {
    claimId: text()
      .notNull()
      .references(() => claims.id),
    sourceId: text()
      .notNull()
      .references(() => sourceDocuments.id),
    createdAt: now(),
  },
  (t) => [primaryKey({ columns: [t.claimId, t.sourceId] })],
);

// ---------- 候选方向 ----------

/** 候选内容方向：结构化选题及其评分输入快照 */
export const directionOptions = sqliteTable(
  'direction_option',
  {
    id: uuidPk(),
    runId: text()
      .notNull()
      .references(() => workflowRuns.id),
    title: text().notNull(),
    summary: text().notNull(),
    targetAudience: text().notNull(),
    keywords: text({ mode: 'json' }).notNull(),
    /** 各维度评分：{ sourceCoverage, audienceMatch, platformMatch, novelty, timeliness, risk } */
    scoreFactors: text({ mode: 'json' }).notNull(),
    totalScore: real().notNull(),
    /** 展示排序位次（1 起始） */
    rank: integer().notNull(),
    /** 排序输入快照（审计用） */
    scoringInputs: text({ mode: 'json' }).notNull(),
    createdAt: now(),
  },
  (t) => [index('direction_option_run_rank_idx').on(t.runId, t.rank)],
);

/** 方向-事实关联 */
export const directionClaims = sqliteTable(
  'direction_claim',
  {
    directionId: text()
      .notNull()
      .references(() => directionOptions.id),
    claimId: text()
      .notNull()
      .references(() => claims.id),
  },
  (t) => [primaryKey({ columns: [t.directionId, t.claimId] })],
);

// ---------- 内容制品 ----------

/** 内容制品：CANONICAL 规范文章与 XIAOHONGSHU 衍生稿，按版本递增 */
export const contentArtifacts = sqliteTable(
  'content_artifact',
  {
    id: uuidPk(),
    runId: text()
      .notNull()
      .references(() => workflowRuns.id),
    kind: contentArtifactKindColumn().notNull(),
    version: integer().notNull(),
    title: text(),
    body: text().notNull(),
    tags: text({ mode: 'json' }).notNull(),
    /** 媒体对象存储键（有序数组） */
    mediaObjectKeys: text({ mode: 'json' }).notNull(),
    /** 事实使用位置：[{ artifactKind, locator, claimId }] */
    claimUsages: text({ mode: 'json' }).notNull(),
    /** 生成元数据：{ provider, model, promptVersion, generatedAt, sourceIds, tokenUsage } */
    generation: text({ mode: 'json' }),
    aiGenerated: integer({ mode: 'boolean' }).notNull().default(true),
    aigcDisclosure: aigcDisclosureColumn().notNull().default('undisclosed'),
    humanReview: humanReviewColumn().notNull().default('not_reviewed'),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex('content_artifact_run_kind_version_unique').on(
      t.runId,
      t.kind,
      t.version,
    ),
  ],
);
