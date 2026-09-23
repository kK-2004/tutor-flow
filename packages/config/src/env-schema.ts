import { z } from 'zod';

/**
 * 环境变量 schema 定义。
 *
 * 约定：
 * - 敏感凭据不直接进入各进程的业务配置，业务代码只能持有 `secret_ref` 引用，
 *   运行时通过密钥提供器（见 server/secret-provider.ts）解析；
 * - 每类进程使用独立 schema，从 process.env 中只摘取声明过的键，
 *   未声明键一律不进入配置对象，避免意外把敏感值带进构建产物。
 */

/** 日志级别 */
export const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof logLevelSchema>;

/** 运行环境 */
export const nodeEnvSchema = z.enum(['development', 'test', 'production']);
export type NodeEnv = z.infer<typeof nodeEnvSchema>;

const nodeEnvField = nodeEnvSchema.default('development');
const logLevelField = logLevelSchema.default('info');
/** SQLite 数据库文件路径（本地单文件，无需独立数据库服务） */
const sqlitePathField = z.string().min(1).default('./data/tutor-flow.db');
const redisUrlField = z.string().min(1);

/**
 * API 进程环境。
 *
 * SCHEDULER_TOKEN / OPERATOR_TOKEN 缺省时对应触发方式不可用；
 * 管理台身份认证方案待定（见设计文档待确认事项），先以令牌边界实现。
 */
export const apiEnvSchema = z
  .object({
    NODE_ENV: nodeEnvField,
    LOG_LEVEL: logLevelField,
    API_HOST: z.string().min(1).default('127.0.0.1'),
    API_PORT: z.coerce.number().int().positive().default(4000),
    SQLITE_PATH: sqlitePathField,
    REDIS_URL: redisUrlField,
    SCHEDULER_TOKEN: z.string().min(1).optional(),
    OPERATOR_TOKEN: z.string().min(1).optional(),
    CONTENT_CENTER_URL: z.url().optional(),
    CONTENT_CENTER_TOKEN_REF: z.string().min(5).default('env:KFILE_APP_TOKEN'),
    XHS_MCP_URL: z.url().optional(),
    XHS_MCP_ACCOUNT_ID: z.uuid().optional(),
    XHS_MCP_AUTH_TOKEN_REF: z.string().min(5).optional(),
  })
  .strict();
export type ApiEnv = z.infer<typeof apiEnvSchema>;

/** Worker 进程环境（研究、生成、发布队列处理器） */
export const workerEnvSchema = z
  .object({
    NODE_ENV: nodeEnvField,
    LOG_LEVEL: logLevelField,
    SQLITE_PATH: sqlitePathField,
    REDIS_URL: redisUrlField,
    // 搜索网关：首期 Brave（密钥经密钥提供器解析，不落明文配置）
    SEARCH_PROVIDER: z.enum(['brave']).default('brave'),
    SEARCH_BRAVE_ENDPOINT: z
      .url()
      .default('https://api.search.brave.com/res/v1/web/search'),
    SEARCH_BRAVE_SECRET_REF: z.string().min(1).default('env:BRAVE_API_KEY'),
    // S3 兼容对象存储（接入已部署的 MinIO）：AI 生成图片等媒体资产
    S3_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_BUCKET: z.string().min(1).optional(),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    CONTENT_CENTER_URL: z.url().optional(),
    CONTENT_CENTER_TOKEN_REF: z.string().min(5).default('env:KFILE_APP_TOKEN'),
    // 小红书 MCP sidecar 地址：由 Publisher Worker 独占使用
    XHS_MCP_URL: z.url().optional(),
    XHS_MCP_ACCOUNT_ID: z.uuid().optional(),
    XHS_MCP_AUTH_TOKEN_REF: z.string().min(5).optional(),
    // 生产发布器必须同时提供不可变版本标识，避免 sidecar 漂移
    XHS_MCP_COMMIT: z
      .string()
      .regex(/^[0-9a-f]{7,40}$/i)
      .optional(),
    XHS_MCP_IMAGE_DIGEST: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/i)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.NODE_ENV === 'production' &&
      value.XHS_MCP_URL !== undefined &&
      (value.XHS_MCP_COMMIT === undefined || value.XHS_MCP_IMAGE_DIGEST === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['XHS_MCP_COMMIT'],
        message: '生产环境启用发布器时必须固定 MCP commit 与镜像摘要',
      });
    }
  });
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/**
 * 管理台（Next.js 服务端）环境。
 *
 * 只允许非敏感的服务端配置；浏览器端可见值必须以 NEXT_PUBLIC_ 开头，
 * 且只能包含非敏感项（见 client/index.ts）。
 */
export const consoleServerEnvSchema = z
  .object({
    NODE_ENV: nodeEnvField,
    // 管理台服务端访问 API 的基础地址
    CONSOLE_API_BASE_URL: z.url().default('http://127.0.0.1:4000'),
    // 服务端到 API 的内部凭据（如启用服务间认证时使用）
    INTERNAL_API_TOKEN: z.string().min(1).optional(),
  })
  .strict();
export type ConsoleServerEnv = z.infer<typeof consoleServerEnvSchema>;

/**
 * 从 process.env 摘取指定键，返回仅包含声明键的对象。
 *
 * 使用方括号访问以满足 noPropertyAccessFromIndexSignature 约束。
 */
export function readEnv(keys: readonly string[]): Record<string, string | undefined> {
  const picked: Record<string, string | undefined> = {};
  for (const key of keys) {
    picked[key] = process.env[key];
  }
  return picked;
}
