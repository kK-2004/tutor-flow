import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  apiEnvSchema,
  consoleServerEnvSchema,
  readEnv,
  workerEnvSchema,
  type ApiEnv,
  type ConsoleServerEnv,
  type WorkerEnv,
} from '../env-schema.js';

/**
 * 服务端环境加载器。
 *
 * 每类进程只加载自己的环境分组；解析失败立即抛错（fail-fast），
 * 不允许服务带错配置启动。加载结果冻结并缓存，保证进程内一致。
 */

const API_ENV_KEYS = [
  'NODE_ENV',
  'LOG_LEVEL',
  'API_HOST',
  'API_PORT',
  'SQLITE_PATH',
  'REDIS_URL',
  'SCHEDULER_TOKEN',
  'OPERATOR_TOKEN',
  'CONTENT_CENTER_URL',
  'CONTENT_CENTER_TOKEN_REF',
  'XHS_MCP_URL',
  'XHS_MCP_ACCOUNT_ID',
  'XHS_MCP_AUTH_TOKEN_REF',
] as const;

const WORKER_ENV_KEYS = [
  'NODE_ENV',
  'LOG_LEVEL',
  'SQLITE_PATH',
  'REDIS_URL',
  'SEARCH_PROVIDER',
  'SEARCH_BRAVE_ENDPOINT',
  'SEARCH_BRAVE_SECRET_REF',
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'CONTENT_CENTER_URL',
  'CONTENT_CENTER_TOKEN_REF',
  'XHS_MCP_URL',
  'XHS_MCP_ACCOUNT_ID',
  'XHS_MCP_AUTH_TOKEN_REF',
] as const;

const CONSOLE_SERVER_ENV_KEYS = [
  'NODE_ENV',
  'CONSOLE_API_BASE_URL',
  'INTERNAL_API_TOKEN',
] as const;

function assertServerRuntime(): void {
  // 防御：服务端配置模块被误打进浏览器包时立即暴露问题
  // （不引入 DOM lib，改用 globalThis 探测浏览器全局对象）
  const browserGlobal = (globalThis as { window?: unknown }).window;
  if (typeof browserGlobal !== 'undefined') {
    throw new Error('服务端环境配置不允许在浏览器运行时加载');
  }
}

let cachedApiEnv: ApiEnv | null = null;

/** 加载并校验 API 进程环境 */
export function loadApiEnv(): ApiEnv {
  assertServerRuntime();
  if (cachedApiEnv === null) {
    cachedApiEnv = apiEnvSchema.parse(readEnv(API_ENV_KEYS));
    Object.freeze(cachedApiEnv);
  }
  return cachedApiEnv;
}

let cachedWorkerEnv: WorkerEnv | null = null;

/** 加载并校验 Worker 进程环境 */
export function loadWorkerEnv(): WorkerEnv {
  assertServerRuntime();
  if (cachedWorkerEnv === null) {
    cachedWorkerEnv = workerEnvSchema.parse(readEnv(WORKER_ENV_KEYS));
    Object.freeze(cachedWorkerEnv);
  }
  return cachedWorkerEnv;
}

let cachedConsoleServerEnv: ConsoleServerEnv | null = null;

/** 加载并校验管理台服务端环境 */
export function loadConsoleServerEnv(): ConsoleServerEnv {
  assertServerRuntime();
  if (cachedConsoleServerEnv === null) {
    cachedConsoleServerEnv = consoleServerEnvSchema.parse(
      readEnv(CONSOLE_SERVER_ENV_KEYS),
    );
    Object.freeze(cachedConsoleServerEnv);
  }
  return cachedConsoleServerEnv;
}

/**
 * 若存在 .env 文件则加载（不覆盖已有环境变量）。
 *
 * 供本地开发使用：生产环境应使用进程管理器或容器注入环境变量。
 */
export function loadDotenvIfPresent(path = '.env'): void {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    // 去掉成对引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined && key.length > 0) {
      process.env[key] = value;
    }
  }
}

/** 测试辅助：清空已缓存的环境（仅在单测中使用） */
export function resetEnvCacheForTests(): void {
  cachedApiEnv = null;
  cachedWorkerEnv = null;
  cachedConsoleServerEnv = null;
}

/**
 * 解析 SQLite 数据库路径：相对路径以仓库根为基准，
 * 保证 API、Worker 与迁移脚本操作同一个库文件。
 */
export function resolveDatabasePath(p: string): string {
  if (path.isAbsolute(p)) {
    return p;
  }
  // 从当前目录向上查找 pnpm-workspace.yaml 定位仓库根
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      return path.join(dir, p);
    }
    dir = path.dirname(dir);
  }
  return path.resolve(p);
}
