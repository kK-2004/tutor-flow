/**
 * 仓储层错误类型。
 *
 * API 层据此映射 HTTP 状态码：冲突 409、锁竞争 409/429。
 */

/** 乐观锁版本不匹配 */
export class OptimisticLockError extends Error {
  constructor(message = '数据已被并发修改，请刷新后重试') {
    super(message);
    this.name = 'OptimisticLockError';
  }
}

/** 幂等键冲突：同键不同载荷 */
export class IdempotencyConflictError extends Error {
  constructor(message = '幂等键已存在且载荷不一致') {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

/** 草稿修订冲突：保存版本落后于最新版本 */
export class RevisionConflictError extends Error {
  readonly latestRevision: number;

  constructor(latestRevision: number, message = '草稿版本已过期，存在较新的修订') {
    super(message);
    this.name = 'RevisionConflictError';
    this.latestRevision = latestRevision;
  }
}

/** 状态守卫拒绝：非法状态转换或资源不可操作 */
export class StateGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateGuardError';
  }
}

/** 实体不存在 */
export class NotFoundError extends Error {
  constructor(message = '资源不存在') {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** PostgreSQL 唯一约束冲突错误码 */
export const PG_UNIQUE_VIOLATION = '23505';
