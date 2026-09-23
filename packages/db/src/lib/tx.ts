/**
 * 事务与执行器类型。
 *
 * 仓储方法统一接受 DbExecutor（库或事务），
 * 需要原子性时由调用方通过 withTx 包裹。
 */
import type { ResultSet } from '@libsql/client';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type { SQLiteTransaction } from 'drizzle-orm/sqlite-core';

import type * as schema from '../schema/index.js';

/** 数据库实例类型 */
export type Db = LibSQLDatabase<typeof schema>;

/** 事务类型 */
export type DbTx = SQLiteTransaction<
  'async',
  ResultSet,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/** 可执行器：数据库实例或打开的事务 */
export type DbExecutor = Db | DbTx;

/** 在事务中执行回调；回调抛错时整体回滚 */
export async function withTx<T>(db: Db, fn: (tx: DbTx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => fn(tx));
}
