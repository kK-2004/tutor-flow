/**
 * 服务端专用入口：环境加载器与密钥提供器。
 *
 * 仅允许在服务端进程（API、Worker、Next.js 服务端）导入；
 * 客户端代码导入此入口将破坏“凭据不进浏览器构建产物”的约束。
 */
export {
  loadApiEnv,
  loadConsoleServerEnv,
  loadDotenvIfPresent,
  loadWorkerEnv,
  resolveDatabasePath,
  resetEnvCacheForTests,
} from './env.js';

export type { ApiEnv, ConsoleServerEnv, WorkerEnv } from '../env-schema.js';

export {
  EnvSecretProvider,
  InMemorySecretProvider,
  maskSecretRef,
  type SecretProvider,
} from './secret-provider.js';
export { decryptLocalSecret, encryptLocalSecret } from './local-secret-vault.js';
