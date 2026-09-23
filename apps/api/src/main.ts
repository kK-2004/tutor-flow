/**
 * API 服务入口。
 *
 * 启动前加载 .env（本地开发）并校验环境配置（fail-fast），
 * 随后构建 Fastify 实例并监听。
 */
import { loadApiEnv, loadDotenvIfPresent } from '@tutor-flow/config/server';

import { buildApp } from './app.js';

loadDotenvIfPresent();
const env = loadApiEnv();

const handle = await buildApp({ env });
const { app } = handle;

async function shutdown(): Promise<void> {
  await app.close();
  await handle.db.close();
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});

app
  .listen({ port: env.API_PORT, host: env.API_HOST })
  .then((address) => {
    app.log.info(`API 已启动：${address}`);
  })
  .catch((error: unknown) => {
    app.log.error(error, 'API 启动失败');
    process.exit(1);
  });
