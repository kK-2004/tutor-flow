/**
 * 工作流核心表（SQLite）：内容任务、运行任务、步骤尝试、
 * 工作流事件、发件箱记录与触发幂等记录。
 *
 * 约定：
 * - 所有枚举值来自 @tutor-flow/domain，禁止在 schema 中写字符串字面量；
 * - SQLite 无原生枚举/UUID/JSON 类型：枚举用 text（应用层守卫），
 *   UUID 用 text + 应用层生成，JSON 用 text({ mode: 'json' })；
 * - 时间列统一 integer（毫秒时间戳，Date 映射）；
 * - 大文本一律存对象存储，库内只存引用。
 */
import { randomUUID } from 'node:crypto';

import {
  DIRECTION_MODES,
  ERROR_CATEGORIES,
  PLATFORMS,
  PUBLISH_MODES,
  RUN_STATUSES,
  STEP_ATTEMPT_STATUSES,
  STEP_TYPES,
  TRIGGER_TYPES,
} from '@tutor-flow/domain';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// ---------- 通用列辅助 ----------

/** 应用层生成的 UUID 主键 */
const uuidPk = () =>
  text()
    .primaryKey()
    .$defaultFn(() => randomUUID());

/** 毫秒时间戳列（Date 映射） */
const timestampMs = () => integer({ mode: 'timestamp_ms' });

const now = () =>
  timestampMs()
    .notNull()
    .$defaultFn(() => new Date());

// ---------- 枚举定义（text + 应用层枚举约束） ----------

/** 运行状态列 */
export const runStatusColumn = () => text({ enum: RUN_STATUSES });
/** 方向决策模式列 */
export const directionModeColumn = () => text({ enum: DIRECTION_MODES });
/** 发布审核模式列 */
export const publishModeColumn = () => text({ enum: PUBLISH_MODES });
/** 触发来源列 */
export const triggerTypeColumn = () => text({ enum: TRIGGER_TYPES });
/** 目标平台列 */
export const platformColumn = () => text({ enum: PLATFORMS });
/** 步骤类型列 */
export const stepTypeColumn = () => text({ enum: STEP_TYPES });
/** 步骤尝试状态列 */
export const stepAttemptStatusColumn = () => text({ enum: STEP_ATTEMPT_STATUSES });
/** 错误分类列 */
export const errorCategoryColumn = () => text({ enum: ERROR_CATEGORIES });

// ---------- 内容任务 ----------

/**
 * 内容任务：业务层的一次内容生产请求（主题、模式、平台、账号、触发信息）。
 * 运行任务是它的可恢复执行实例。
 */
export const contentJobs = sqliteTable(
  'content_job',
  {
    id: uuidPk(),
    /** 内容主题（非空） */
    topic: text().notNull(),
    directionMode: directionModeColumn().notNull(),
    publishMode: publishModeColumn().notNull(),
    platform: platformColumn().notNull(),
    /** 小红书平台账号（应用层校验存在性；避免与 publishing 的表循环引用） */
    accountId: text().notNull(),
    triggerType: triggerTypeColumn().notNull(),
    /** 操作主体：运营人员标识或调度器身份 */
    triggeredBy: text().notNull(),
    /** 调度器计划键（审计关联用） */
    schedulerKey: text(),
    /** 期望执行时间（仅审计，由外部调度器拥有） */
    expectedRunAt: timestampMs(),
    createdAt: now(),
  },
  (t) => [
    index('content_job_account_idx').on(t.accountId),
    index('content_job_created_idx').on(t.createdAt),
  ],
);

// ---------- 运行任务 ----------

/** 运行任务：绑定内容任务的可恢复状态机实例 */
export const workflowRuns = sqliteTable(
  'workflow_run',
  {
    id: uuidPk(),
    contentJobId: text()
      .notNull()
      .references(() => contentJobs.id),
    status: runStatusColumn().notNull().default('QUEUED'),
    /** 当前推进到的步骤类型（检查点恢复的依据之一） */
    currentStepType: stepTypeColumn(),
    /** 自动重试次数（人工重试记录在 step_run 尝试中） */
    retryCount: integer().notNull().default(0),
    /** 进入人工等待的时间（人工等待时长指标用） */
    humanWaitSince: timestampMs(),
    cancelRequested: integer({ mode: 'boolean' }).notNull().default(false),
    cancelRequestedAt: timestampMs(),
    cancelRequestedBy: text(),
    /** 选中的候选方向（自动选向或人工选向后回填） */
    selectedDirectionId: text(),
    /** 乐观锁版本号 */
    version: integer().notNull().default(1),
    /** 链路追踪 id */
    traceId: text(),
    createdAt: now(),
    updatedAt: now(),
  },
  (t) => [
    index('workflow_run_status_idx').on(t.status),
    index('workflow_run_job_idx').on(t.contentJobId),
  ],
);

// ---------- 步骤尝试 ----------

/** 步骤尝试：每次执行落在具体步骤上，保留全部尝试用于审计 */
export const stepRuns = sqliteTable(
  'step_run',
  {
    id: uuidPk(),
    runId: text()
      .notNull()
      .references(() => workflowRuns.id),
    stepType: stepTypeColumn().notNull(),
    /** 同一步骤内的尝试序号，从 1 开始 */
    attemptNo: integer().notNull(),
    status: stepAttemptStatusColumn().notNull().default('PENDING'),
    /** 输入摘要哈希（幂等校验用，不存原文） */
    inputHash: text(),
    /** 输出引用（对象键或记录 id） */
    outputRef: text(),
    errorCategory: errorCategoryColumn(),
    /** 面向运营的中文错误说明（已脱敏） */
    errorMessage: text(),
    traceId: text(),
    startedAt: timestampMs(),
    finishedAt: timestampMs(),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex('step_run_attempt_unique').on(t.runId, t.stepType, t.attemptNo),
    index('step_run_run_idx').on(t.runId),
  ],
);

// ---------- 工作流事件 ----------

/**
 * 持久化工作流事件：先落库再经 SSE 推送。
 * id 为全局单调递增（SSE Last-Event-ID），seq 为运行内序号。
 */
export const workflowEvents = sqliteTable(
  'workflow_event',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    runId: text()
      .notNull()
      .references(() => workflowRuns.id),
    seq: integer().notNull(),
    name: text().notNull(),
    payload: text({ mode: 'json' }).notNull(),
    occurredAt: now(),
  },
  (t) => [uniqueIndex('workflow_event_run_seq_unique').on(t.runId, t.seq)],
);

// ---------- 发件箱 ----------

/** 事务性发件箱：与业务状态同事务写入，由分发器投递到 BullMQ */
export const outboxRecords = sqliteTable(
  'outbox_record',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    eventName: text().notNull(),
    aggregateType: text().notNull(),
    aggregateId: text().notNull(),
    payload: text({ mode: 'json' }).notNull(),
    /** 分发尝试次数（0 表示尚未分发） */
    attempts: integer().notNull().default(0),
    dispatchedAt: timestampMs(),
    /** 分发失败的脱敏错误说明 */
    lastError: text(),
    createdAt: now(),
  },
  (t) => [
    index('outbox_pending_idx').on(t.dispatchedAt, t.id),
    index('outbox_aggregate_idx').on(t.aggregateType, t.aggregateId),
  ],
);

// ---------- 触发幂等 ----------

/**
 * 触发幂等记录：同一调用方 + 幂等键在保留期内唯一。
 * request_hash 用于载荷冲突检测（同键不同载荷返回 409）。
 */
export const triggerIdempotencyRecords = sqliteTable(
  'trigger_idempotency',
  {
    id: uuidPk(),
    /** 调用方身份（如 scheduler:xxx 或 operator:yyy） */
    callerIdentity: text().notNull(),
    idempotencyKey: text().notNull(),
    /** 规范化载荷的哈希 */
    requestHash: text().notNull(),
    contentJobId: text()
      .notNull()
      .references(() => contentJobs.id),
    workflowRunId: text()
      .notNull()
      .references(() => workflowRuns.id),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex('trigger_idempotency_caller_key_unique').on(
      t.callerIdentity,
      t.idempotencyKey,
    ),
  ],
);
