/**
 * 数据库锁辅助（SQLite 适配）。
 *
 * SQLite 采用单写者模型：同一时刻只允许一个写事务，
 * 写事务本身就是互斥锁。因此发布副作用解析的
 * 「持锁 → 查回执 → 决定是否发布」模式在 SQLite 下天然安全：
 * 回执查询与回执写入发生在同一个写事务内即可。
 *
 * 原 PostgreSQL 的 pg_advisory_xact_lock 辅助方法保留为兼容空实现，
 * 调用方无需改动；迁移到多写者数据库时恢复为真实咨询锁。
 */
import type { DbExecutor } from './tx.js';

/** 计算发布锁键（与幂等键同源；SQLite 下仅用于日志辨识） */
export async function advisoryXactLock(
  _executor: DbExecutor,
  _key: string,
): Promise<void> {
  // SQLite 单写者：写事务即互斥，无需额外锁原语
  return Promise.resolve();
}
