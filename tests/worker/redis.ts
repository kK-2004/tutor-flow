/**
 * 队列集成测试的 Redis 可用性探测。
 *
 * 本项目不通过 Docker 部署服务：CI 环境没有 Redis 时，
 * 队列集成测试自动跳过；本地开发接入已部署的 Redis 后照常运行。
 */
import { Redis } from 'ioredis';

/** 探测本地 Redis 是否可用（PING 超时 1 秒；不重试、不打印连接错误） */
export async function isRedisAvailable(redisUrl?: string): Promise<boolean> {
  const url = redisUrl ?? process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379';
  const connection = new Redis(url, {
    lazyConnect: true,
    // 探测专用：失败立即放弃，不做退避重连
    retryStrategy: () => null,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 1_000,
  });
  // 连接失败属于预期分支，静默处理避免 unhandled error event
  connection.on('error', () => undefined);
  try {
    await connection.connect();
    const result = await connection.ping();
    return result === 'PONG';
  } catch {
    return false;
  } finally {
    connection.disconnect();
  }
}
