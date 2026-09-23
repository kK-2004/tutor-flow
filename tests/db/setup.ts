/**
 * 数据库集成测试环境：SQLite 临时文件库 + 迁移 + 表清空。
 *
 * 每个测试进程使用独立的临时文件（进程 pid + 时间戳命名），互不干扰；
 * 迁移与种子幂等执行。
 */
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import path from 'node:path';
import { tmpdir } from 'node:os';

import * as schema from '../../packages/db/src/schema/index.js';
import { seedDefaultSettings } from '../../packages/db/src/seed.js';
import { createDb, type DbClient } from '../../packages/db/src/client.js';

/** 临时文件库（每个测试进程独立；内存库无法跨连接共享） */
export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  path.join(tmpdir(), `tutor-flow-test-${process.pid}-${Date.now()}.db`);

const MIGRATIONS_FOLDER = path.resolve(import.meta.dirname, '../../packages/db/drizzle');

/** 确保迁移与种子初始化完成（幂等） */
export async function setupTestDatabase(): Promise<void> {
  const url = TEST_DATABASE_URL.startsWith('file:')
    ? TEST_DATABASE_URL
    : `file:${TEST_DATABASE_URL}`;
  const client = createClient({ url });
  const migrateDb = drizzle(client, { schema, casing: 'snake_case' });
  try {
    await migrate(migrateDb, { migrationsFolder: MIGRATIONS_FOLDER });
    await seedDefaultSettings(migrateDb, 'test:seed');
  } finally {
    client.close();
  }
}

/** 创建测试用数据库客户端 */
export function createTestDb(): DbClient {
  return createDb({ path: TEST_DATABASE_URL, applicationName: 'test' });
}

/** 清空全部业务表（先临时摘除审计防删触发器） */
export async function truncateAll(db: DbClient): Promise<void> {
  const tables = [
    'admin_session',
    'admin_user',
    'publish_receipt',
    'publish_job',
    'draft_revision',
    'platform_account',
    'platform_policy',
    'claim_source',
    'direction_claim',
    'claim',
    'direction_option',
    'content_artifact',
    'source_document',
    'duplicate_cluster',
    'query_plan',
    'trigger_idempotency',
    'outbox_record',
    'workflow_event',
    'step_run',
    'workflow_run',
    'content_job',
    'system_setting',
    'audit_event',
  ];
  await db.client.batch(
    [
      'DROP TRIGGER IF EXISTS audit_event_immutable_update',
      'DROP TRIGGER IF EXISTS audit_event_immutable_delete',
      ...tables.map((table) => `DELETE FROM ${table}`),
      `CREATE TRIGGER audit_event_immutable_update
        BEFORE UPDATE ON "audit_event"
      BEGIN
        SELECT RAISE(ABORT, 'audit_event 为只追加表，禁止更新或删除');
      END`,
      `CREATE TRIGGER audit_event_immutable_delete
        BEFORE DELETE ON "audit_event"
      BEGIN
        SELECT RAISE(ABORT, 'audit_event 为只追加表，禁止更新或删除');
      END`,
    ],
    'write',
  );
}
