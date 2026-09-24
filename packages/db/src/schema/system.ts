/**
 * 系统级表（SQLite）：系统设置与审计事件。
 *
 * 约定：
 * - system_setting 只存非敏感配置；密钥类配置不在此表出现；
 * - audit_event 为只追加表，由数据库触发器阻止 UPDATE/DELETE
 *   （触发器在迁移 SQL 中定义）。
 */
import { randomUUID } from 'node:crypto';

import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const uuidPk = () =>
  text()
    .primaryKey()
    .$defaultFn(() => randomUUID());

const now = () =>
  integer({ mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date());

/** 管理后台用户：仅保存不可逆密码哈希。 */
export const adminUsers = sqliteTable(
  'admin_user',
  {
    id: uuidPk(),
    username: text().notNull(),
    passwordHash: text().notNull(),
    role: text({ enum: ['SUPER_ADMIN', 'ADMIN'] }).notNull(),
    createdBy: text(),
    createdAt: now(),
    updatedAt: now(),
  },
  (t) => [uniqueIndex('admin_user_username_unique').on(t.username)],
);

/** 管理后台会话：仅保存随机令牌摘要，原始令牌只存在于 HttpOnly Cookie。 */
export const adminSessions = sqliteTable(
  'admin_session',
  {
    tokenHash: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'cascade' }),
    expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
    createdAt: now(),
    lastSeenAt: now(),
  },
  (t) => [
    index('admin_session_user_idx').on(t.userId),
    index('admin_session_expires_idx').on(t.expiresAt),
  ],
);

/** 系统设置：保存非敏感配置与加密后的模型凭据 */
export const systemSettings = sqliteTable('system_setting', {
  /** 设置键（如 quality_thresholds、search_budget） */
  key: text().primaryKey(),
  value: text({ mode: 'json' }).notNull(),
  /** 乐观锁版本 */
  version: integer().notNull().default(1),
  updatedBy: text(),
  createdAt: integer({ mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer({ mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * 审计事件：不可变操作记录（配置变更、方向决策、编辑、批准、
 * 重试、外部调用与人工解决）。
 */
export const auditEvents = sqliteTable(
  'audit_event',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    occurredAt: integer({ mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    /** 动作主体类型：operator / scheduler / system / worker */
    actorType: text().notNull(),
    /** 主体标识（运营人员 id、调度器身份或进程名） */
    actorId: text().notNull(),
    /** 动作名（如 direction.selected / draft.approved） */
    action: text().notNull(),
    /** 资源类型与标识 */
    resourceType: text().notNull(),
    resourceId: text().notNull(),
    /** 可选关联（便于按工作流或发布任务检索审计） */
    runId: text(),
    publishJobId: text(),
    /** 脱敏载荷（不含正文、Cookie 与密钥） */
    payload: text({ mode: 'json' }),
    traceId: text(),
  },
  (t) => [
    index('audit_event_occurred_idx').on(t.occurredAt),
    index('audit_event_resource_idx').on(t.resourceType, t.resourceId),
    index('audit_event_run_idx').on(t.runId),
  ],
);
