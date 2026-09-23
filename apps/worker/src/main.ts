/**
 * Worker 进程入口。
 *
 * 启动前先加载并校验环境配置（fail-fast），随后启动：
 * - 健康检查服务（/healthz、/readyz）
 * - 事务性发件箱分发器（Outbox → BullMQ）
 * - 工作流引擎驱动的步骤消费者（幂等中间件 + 检查点推进）
 * - 重启恢复扫描
 */
import { createDb, getSetting } from '@tutor-flow/db';
import { loadWorkerEnv, resolveDatabasePath } from '@tutor-flow/config/server';
import { EnvSecretProvider } from '@tutor-flow/config/server';
import {
  DEFAULT_CONTENT_CENTER_SETTINGS,
  parseContentCenterSettings,
  type StepType,
} from '@tutor-flow/domain';
import {
  createContentCenterClient,
  createHttpMcpToolCaller,
  createMcpPublisherAdapter,
} from '@tutor-flow/integrations';
import {
  createStepProcessor,
  createWorkflowEngine,
  type StepHandler,
} from '@tutor-flow/workflow';
import { Worker } from 'bullmq';

import { HealthServer } from './health.js';
import { OutboxDispatcher } from './dispatcher.js';
import { WORKFLOW_QUEUE, createConnection, createQueues } from './queues.js';
import type { StepJobData } from './queues.js';
import { createPublishJobProcessor } from './publisher/processor.js';
import { createMetrics } from '@tutor-flow/observability';

const env = loadWorkerEnv();
const workerMetrics = createMetrics();

// 数据库客户端：步骤处理与发件箱分发的状态事实来源
const db = createDb({
  path: resolveDatabasePath(env.SQLITE_PATH),
  applicationName: 'tutor-flow-worker',
});

// 工作流引擎：检查点推进、失败处置、恢复扫描
const engine = createWorkflowEngine(db);

// 业务步骤处理器注册表：随研究（4.x）、生成（5.x）任务逐步注册
const businessHandlers: Partial<Record<StepType, StepHandler>> = {};

const connection = createConnection(env.REDIS_URL);
const queues = createQueues(connection);
const contentCenterUrl = env.CONTENT_CENTER_URL;
const contentCenterSecrets = new EnvSecretProvider();
const mcpAuthTokenRef = env.XHS_MCP_AUTH_TOKEN_REF;

// 发布器单独绑定 publishing 队列；未明确绑定唯一账号时不消费排队任务。
const publisherAdapter =
  env.XHS_MCP_URL && env.XHS_MCP_ACCOUNT_ID
    ? createMcpPublisherAdapter({
        boundAccountId: env.XHS_MCP_ACCOUNT_ID,
        callTool: createHttpMcpToolCaller(
          env.XHS_MCP_URL,
          60_000,
          mcpAuthTokenRef
            ? () => contentCenterSecrets.resolveSecret(mcpAuthTokenRef)
            : undefined,
        ),
        resolveMediaUrl: contentCenterUrl
          ? async (fileId) => {
              const item = await getSetting(db.db, 'content_center');
              const settings =
                item === null
                  ? DEFAULT_CONTENT_CENTER_SETTINGS
                  : parseContentCenterSettings(item.value);
              const token = await contentCenterSecrets.resolveSecret(
                env.CONTENT_CENTER_TOKEN_REF,
              );
              const client = createContentCenterClient({
                baseUrl: contentCenterUrl,
                appToken: token,
              });
              const link = await client.getCdnLink(fileId, settings.cdnExpiresIn);
              return link.url;
            }
          : undefined,
      })
    : null;
const publisherWorker = publisherAdapter
  ? new Worker(
      'publishing',
      createPublishJobProcessor({
        db,
        adapter: publisherAdapter,
        secrets: new EnvSecretProvider(),
        queue: queues.publishing,
        metrics: workerMetrics,
      }),
      { connection },
    )
  : null;

// 步骤消费者：幂等中间件 + 引擎钩子
const processStepJob = createStepProcessor({
  db,
  metrics: workerMetrics,
  handlers: { ...engine.builtInHandlers, ...businessHandlers },
  onStepSuccess: async ({ run, data }) => {
    await engine.advanceAfterStep(run.id, data.stepType);
  },
  onStepFailure: async ({ run, data, attempt, category, message }) => {
    await engine.handleStepFailure(run.id, {
      stepType: data.stepType,
      stepRunId: attempt.id,
      attemptNo: attempt.attemptNo,
      category,
      message,
    });
  },
});

const stepWorker = new Worker<StepJobData>(
  WORKFLOW_QUEUE,
  async (job) => {
    await processStepJob(job);
  },
  { connection },
);

stepWorker.on('failed', (job, error) => {
  console.error(`步骤任务失败：${job?.id ?? '未知'}`, error);
});

publisherWorker?.on('failed', (job, error) => {
  console.error(`发布任务失败：${job?.id ?? '未知'}`, error);
});

// 发件箱分发器：数据库 → BullMQ
const dispatcher = new OutboxDispatcher(db, queues);

// 健康检查：/readyz 探测 Redis 连接
const healthServer = new HealthServer({
  port: Number(process.env['WORKER_HEALTH_PORT'] ?? 4100),
  readinessChecks: [
    {
      name: 'redis',
      check: async () => {
        const result = await connection.ping();
        if (result !== 'PONG') {
          throw new Error(`redis ping 返回异常：${result}`);
        }
      },
    },
  ],
  metrics: () => workerMetrics.snapshot(),
});

dispatcher.start();
console.log('Worker 已启动：发件箱分发器与工作流队列消费者运行中');

// 重启恢复扫描：稍候执行，避开启动风暴
const recoveryTimer = setTimeout(() => {
  engine
    .recoverInterruptedRuns()
    .then((count) => {
      if (count > 0) {
        console.log(`恢复扫描完成：重新入队 ${count} 个未完成运行`);
      }
    })
    .catch((error: unknown) => {
      console.error('恢复扫描失败：', error instanceof Error ? error.message : error);
    });
}, 3_000);

async function shutdown(): Promise<void> {
  clearTimeout(recoveryTimer);
  await dispatcher.stop();
  await stepWorker.close();
  await publisherWorker?.close();
  await queues.close();
  await healthServer.close();
  await db.close();
  connection.disconnect();
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});
