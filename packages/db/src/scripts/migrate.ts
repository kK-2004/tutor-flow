/**
 * 迁移执行脚本：pnpm db:migrate
 *
 * 使用 Drizzle 迁移器按 journal 顺序应用 drizzle/ 下的 SQL 迁移；
 * 每次应用记录在库内迁移表中，天然幂等。
 */
import { mkdirSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import path from 'node:path';

import { loadDotenvIfPresent, resolveDatabasePath } from '@tutor-flow/config/server';

import * as schema from '../schema/index.js';
import { MIN_ADMIN_PASSWORD_LENGTH, seedDefaultSettings } from '../seed.js';

// 本地开发：若存在 .env 则加载（不覆盖已有环境变量）
loadDotenvIfPresent();
// 未配置时回退默认路径（相对路径以仓库根为基准，与 API/Worker 共享同一库）
const databasePath = resolveDatabasePath(
  process.env['SQLITE_PATH'] ?? './data/tutor-flow.db',
);

// 迁移目录相对本文件定位：src/scripts → 仓库 packages/db/drizzle
// （tsx 从源码运行与 tsc 从 dist 运行时相对层级一致）
const migrationsFolder = path.join(path.dirname(import.meta.filename), '../../drizzle');

// 确保父目录存在（相对路径基于当前工作目录）
const dir = path.dirname(databasePath);
if (dir !== '.' && dir !== '') {
  mkdirSync(dir, { recursive: true });
}
const client = createClient({ url: `file:${databasePath}`, timeout: 1_000 });
await client.executeMultiple('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
const db = drizzle(client, { schema, casing: 'snake_case' });

try {
  await migrate(db, { migrationsFolder });
  console.log('迁移已应用：', databasePath);
  // 迁移完成后初始化非敏感默认配置（幂等）
  const bootstrapUsername = process.env['BOOTSTRAP_SUPER_ADMIN_USERNAME'];
  const bootstrapPassword = process.env['BOOTSTRAP_SUPER_ADMIN_PASSWORD'];
  if (
    bootstrapPassword !== undefined &&
    bootstrapPassword.length < MIN_ADMIN_PASSWORD_LENGTH
  ) {
    throw new Error(`初始管理员密码长度不能少于 ${MIN_ADMIN_PASSWORD_LENGTH} 位`);
  }
  await seedDefaultSettings(
    db,
    'system:seed',
    bootstrapUsername && bootstrapPassword
      ? { username: bootstrapUsername, password: bootstrapPassword }
      : undefined,
  );
  console.log('默认配置已就绪');
} catch (error: unknown) {
  console.error('迁移失败：', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  client.close();
}
