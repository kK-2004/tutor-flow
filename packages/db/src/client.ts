/**
 * 数据库客户端：SQLite（libsql）+ Drizzle 实例。
 *
 * 单文件本地数据库（WAL 模式），首期低并发场景完全够用；
 * casing 与 drizzle.config.ts 保持一致（snake_case）。
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';

import * as schema from './schema/index.js';

export interface DbClientOptions {
  /** SQLite 文件路径（或 libsql URL，如 file:./data/tutor-flow.db） */
  path: string;
  /** 可选的应用名（仅用于日志辨识，SQLite 无此概念） */
  applicationName?: string;
}

export interface DbClient {
  db: ReturnType<typeof createDrizzle>;
  /** 底层 libsql 客户端 */
  client: Client;
  /** 关闭连接（进程退出时调用） */
  close(): Promise<void>;
}

function createDrizzle(client: Client) {
  return drizzle(client, { schema, casing: 'snake_case' });
}

/** 创建数据库客户端；父目录不存在时自动创建 */
export function createDb(options: DbClientOptions): DbClient {
  const url = options.path.startsWith('file:') ? options.path : `file:${options.path}`;
  // 本地文件路径：确保父目录存在
  if (url.startsWith('file:')) {
    const filePath = url.slice('file:'.length);
    const dir = path.dirname(filePath);
    if (dir !== '.' && dir !== '') {
      mkdirSync(dir, { recursive: true });
    }
  }
  const client = createClient({ url });
  // 启用外键约束（SQLite 默认关闭）
  void client.execute('PRAGMA foreign_keys = ON;');
  const db = createDrizzle(client);
  return {
    db,
    client,
    async close(): Promise<void> {
      client.close();
    },
  };
}

export { schema };
