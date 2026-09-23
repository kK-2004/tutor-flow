/**
 * 配置共享包入口。
 *
 * 此入口只导出类型与 schema（不含 process.env 读取逻辑），可被任意模块引用；
 * 服务端环境加载与密钥提供器必须从 `@tutor-flow/config/server` 导入，
 * 浏览器端安全配置从 `@tutor-flow/config/client` 导入。
 */
export {
  apiEnvSchema,
  consoleServerEnvSchema,
  readEnv,
  workerEnvSchema,
  type ApiEnv,
  type ConsoleServerEnv,
  type LogLevel,
  type NodeEnv,
  type WorkerEnv,
} from './env-schema.js';

export {
  EnvSecretProvider,
  InMemorySecretProvider,
  maskSecretRef,
  type SecretProvider,
} from './server/secret-provider.js';
