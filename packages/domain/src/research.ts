/**
 * 研究与来源链路领域类型。
 *
 * 网页内容始终是不可信数据：来源文档只保存归一化元数据与
 * 正文引用，任何针对模型的指令都不改变系统行为
 * （见 specs/research-provenance）。
 */

/** 查询意图全集：覆盖不同资料取向（数据库枚举共用） */
export const QUERY_INTENTS = [
  'BASIC_UNDERSTANDING',
  'CHINESE_PRIMARY',
  'ORIGINAL_SOURCE',
  'ENGINEERING',
  'RECENCY',
] as const;

/** 查询意图类型 */
export type QueryIntent = (typeof QUERY_INTENTS)[number];

/** 查询计划中的单条查询 */
export interface PlannedQuery {
  /** 查询文本 */
  query: string;
  language: string;
  intent: QueryIntent;
  /** 生成该查询的模型与提示词版本（审计用） */
  generatedBy: {
    model: string;
    promptVersion: string;
  };
}

/** 来源抓取状态全集（数据库枚举共用） */
export const SOURCE_FETCH_STATUSES = [
  'PENDING',
  'FETCHED',
  'FAILED',
  'BLOCKED',
  'SKIPPED',
] as const;

/** 来源抓取状态 */
export type SourceFetchStatus = (typeof SOURCE_FETCH_STATUSES)[number];

/** 来源类型全集（数据库枚举共用） */
export const SOURCE_TYPES = [
  'OFFICIAL_DOCS',
  'ENGINEERING_BLOG',
  'NEWS',
  'COMMUNITY',
  'PAPER',
  'OTHER',
] as const;

/** 来源类型 */
export type SourceType = (typeof SOURCE_TYPES)[number];

/** 来源在重复聚类中的角色全集（数据库枚举共用） */
export const SOURCE_CLUSTER_ROLES = ['CANONICAL', 'DUPLICATE'] as const;

/** 来源在重复聚类中的角色 */
export type SourceClusterRole = (typeof SOURCE_CLUSTER_ROLES)[number];

/** 评分因子（可配置权重，见 policy.ts） */
export interface SourceScoreFactors {
  /** 权威性 */
  authority: number;
  /** 相关性 */
  relevance: number;
  /** 原创性 */
  originality: number;
  /** 时效性 */
  timeliness: number;
  /** 交叉佐证 */
  corroboration: number;
  /** 语言契合度（中文优先但不牺牲权威原始来源） */
  languageFit: number;
}

/** 归一化来源文档（业务视图；数据库细节见 packages/db） */
export interface SourceDocument {
  id: string;
  runId: string;
  /** 规范化后的 URL */
  canonicalUrl: string;
  title: string;
  domain: string;
  language: string;
  sourceType: SourceType;
  fetchStatus: SourceFetchStatus;
  /** 正文内容哈希（SHA-256 十六进制） */
  contentHash?: string;
  /** 对象存储中的正文对象键（大文本不入库） */
  contentObjectKey?: string;
  /** 发布/更新时间（ISO 8601） */
  publishedAt?: string;
  fetchedAt?: string;
  clusterId?: string;
  clusterRole?: SourceClusterRole;
  scores?: SourceScoreFactors;
  totalScore?: number;
  /** 是否为主要来源（官方文档、原始出处等） */
  isPrimary: boolean;
}

/** 事实（claim）与其来源绑定 */
export interface Claim {
  id: string;
  runId: string;
  /** 事实陈述文本 */
  statement: string;
  /** 支持该事实的全部来源标识（强绑定，缺来源即未验证） */
  sourceIds: string[];
  confidence: number;
  /** 是否有主要来源支持 */
  primarySourceSupported: boolean;
  verifiedAt: string;
  /** 内容中的使用位置（canonical/xiaohongshu 制品内的引用点） */
  usedIn: ClaimUsageLocation[];
}

/** 事实在内容制品中的使用位置 */
export interface ClaimUsageLocation {
  artifactKind: 'CANONICAL' | 'XIAOHONGSHU';
  /** 制品内定位符（段落 id 等） */
  locator: string;
}

/** 无来源事实的处理策略（发布前校验的依据） */
export const UNSUPPORTED_CLAIM_ACTIONS = ['drop', 'regenerate', 'human_review'] as const;
export type UnsupportedClaimAction = (typeof UNSUPPORTED_CLAIM_ACTIONS)[number];
