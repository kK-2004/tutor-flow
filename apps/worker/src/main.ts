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
import {
  EnvSecretProvider,
  loadDotenvIfPresent,
  loadWorkerEnv,
  resolveDatabasePath,
} from '@tutor-flow/config/server';
import {
  createAiSdkLlmGateway,
  createBraveSearchGateway,
  createContentCenterClient,
  ContentCenterError,
  GatewayError,
  type LlmGateway,
  type LlmRequest,
  type SearchGateway,
} from '@tutor-flow/integrations';
import {
  createStepProcessor,
  createWorkflowEngine,
  StepFailure,
} from '@tutor-flow/workflow';
import {
  LLM_MODELS_UPDATED_CHANNEL,
  DEFAULT_CONTENT_CENTER_SETTINGS,
  parseContentCenterSettings,
  parseResearchDocumentImages,
  redactResearchDocumentImageUrls,
  type LlmModelsConfig,
  type ModelSelection,
} from '@tutor-flow/domain';
import { decryptLocalSecret } from '@tutor-flow/config/server';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';

import { HealthServer } from './health.js';
import { OutboxDispatcher } from './dispatcher.js';
import { WORKFLOW_QUEUE, createConnection, createQueues } from './queues.js';
import type { StepJobData } from './queues.js';
import { createMetrics } from '@tutor-flow/observability';
import { createBusinessHandlers } from './business-handlers.js';

loadDotenvIfPresent();
const env = loadWorkerEnv();
const workerMetrics = createMetrics();

// 数据库客户端：步骤处理与发件箱分发的状态事实来源
const db = createDb({
  path: resolveDatabasePath(env.SQLITE_PATH),
  applicationName: 'tutor-flow-worker',
});

await db.ready;

// 工作流引擎：检查点推进、失败处置、恢复扫描
const engine = createWorkflowEngine(db);

const secrets = new EnvSecretProvider();
let configuredSearch: SearchGateway | null = null;
let contentCenter: ReturnType<typeof createContentCenterClient> | null = null;

async function attachResearchDocumentImages(request: LlmRequest): Promise<LlmRequest> {
  const references = parseResearchDocumentImages(request.userPrompt);
  if (references.length === 0) return request;
  if (env.CONTENT_CENTER_URL === undefined) {
    throw new GatewayError('研究资料包含图片，但内容中心未配置', {
      retryable: false,
    });
  }
  if (contentCenter === null) {
    const token = await secrets.resolveSecret(env.CONTENT_CENTER_TOKEN_REF);
    contentCenter = createContentCenterClient({
      baseUrl: env.CONTENT_CENTER_URL,
      appToken: token,
    });
  }
  const savedSettings = await getSetting(db.db, 'content_center');
  const settings =
    savedSettings === null
      ? DEFAULT_CONTENT_CENTER_SETTINGS
      : parseContentCenterSettings(savedSettings.value);
  try {
    const links = await Promise.all(
      references.map(async (image) => {
        const [metadata, download] = await Promise.all([
          contentCenter!.getCdnLink(image.fileId, settings.cdnExpiresIn),
          contentCenter!.getDownloadLink(image.fileId, settings.downloadExpiresIn),
        ]);
        return {
          ...metadata,
          url: await contentCenter!.resolveFinalUrl(download.url),
        };
      }),
    );
    return {
      ...request,
      userPrompt: redactResearchDocumentImageUrls(request.userPrompt),
      images: [
        ...(request.images ?? []),
        ...links.map((image) => ({
          url: image.url,
          mediaType: image.contentType,
          detail: 'low' as const,
        })),
      ],
    };
  } catch (error) {
    if (error instanceof ContentCenterError) {
      throw new GatewayError(`获取研究资料图片直链失败：${error.message}`, {
        retryable: error.status < 0 || error.status >= 500,
        status: error.status > 0 ? error.status : undefined,
      });
    }
    throw error;
  }
}

interface LlmRuntimeCache {
  config: LlmModelsConfig | null;
  gateways: Map<string, LlmGateway>;
  providersWithoutKey: Set<string>;
  providersWithInvalidKey: Set<string>;
}

const llmConfigKey = (selection: ModelSelection): string =>
  `${selection.providerId}:${selection.modelId}`;

async function loadLlmRuntimeCache(): Promise<LlmRuntimeCache> {
  const setting = await getSetting(db.db, 'llm_models');
  const config = (setting?.value as LlmModelsConfig | undefined) ?? null;
  const gateways = new Map<string, LlmGateway>();
  const providersWithoutKey = new Set<string>();
  const providersWithInvalidKey = new Set<string>();
  if (!config) {
    return { config, gateways, providersWithoutKey, providersWithInvalidKey };
  }

  for (const provider of config.providers) {
    if (!provider.apiKeyEncrypted) {
      providersWithoutKey.add(provider.id);
      continue;
    }
    let apiKey: string;
    try {
      apiKey = await decryptLocalSecret(
        provider.apiKeyEncrypted,
        resolveDatabasePath(env.SQLITE_PATH),
      );
    } catch {
      providersWithInvalidKey.add(provider.id);
      continue;
    }
    for (const modelId of provider.models) {
      const selection = { providerId: provider.id, modelId };
      gateways.set(
        llmConfigKey(selection),
        createAiSdkLlmGateway({
          providerId: provider.id,
          baseURL: provider.baseUrl,
          model: modelId,
          apiKey,
          apiMode: provider.apiMode,
        }),
      );
    }
  }
  return { config, gateways, providersWithoutKey, providersWithInvalidKey };
}

let llmRuntimeCache: LlmRuntimeCache = {
  config: null,
  gateways: new Map(),
  providersWithoutKey: new Set(),
  providersWithInvalidKey: new Set(),
};
let llmRefreshInProgress: Promise<void> | null = null;
let llmRefreshRequestedAgain = false;

function refreshLlmRuntimeCache(): Promise<void> {
  if (llmRefreshInProgress) {
    llmRefreshRequestedAgain = true;
    return llmRefreshInProgress;
  }
  llmRefreshInProgress = (async () => {
    do {
      llmRefreshRequestedAgain = false;
      try {
        llmRuntimeCache = await loadLlmRuntimeCache();
        console.log('模型配置缓存已刷新');
      } catch (error) {
        console.error(
          '模型配置缓存刷新失败，继续使用现有缓存：',
          error instanceof Error ? error.message : error,
        );
      }
    } while (llmRefreshRequestedAgain);
  })().finally(() => {
    llmRefreshInProgress = null;
  });
  return llmRefreshInProgress;
}

const llm: LlmGateway = {
  async complete(request) {
    try {
      const preparedRequest = await attachResearchDocumentImages(request);
      const { config } = llmRuntimeCache;
      const taskSelection =
        config?.taskModels[request.task as keyof LlmModelsConfig['taskModels']];
      const selection = taskSelection ?? config?.defaultModel ?? null;

      if (selection !== null) {
        const provider = config?.providers.find(
          (item) => item.id === selection.providerId,
        );
        if (
          !provider ||
          !provider.models.includes(selection.modelId) ||
          !llmRuntimeCache.gateways.has(llmConfigKey(selection))
        ) {
          if (provider && llmRuntimeCache.providersWithoutKey.has(provider.id)) {
            throw new StepFailure(
              'VALIDATION',
              `模型 Provider「${provider.name}」尚未配置 API Key`,
            );
          }
          if (provider && llmRuntimeCache.providersWithInvalidKey.has(provider.id)) {
            throw new StepFailure(
              'VALIDATION',
              '模型 API Key 无法解密，请检查加密密钥文件',
            );
          }
          throw new StepFailure(
            'VALIDATION',
            '所选模型 Provider 配置无效，请检查系统设置',
          );
        }
        return await llmRuntimeCache.gateways
          .get(llmConfigKey(selection))!
          .complete(preparedRequest);
      }
      throw new StepFailure('VALIDATION', '请先在系统设置中配置模型 Provider 和默认模型');
    } catch (error) {
      if (error instanceof GatewayError) {
        throw new StepFailure(
          error.retryable ? 'TRANSIENT' : 'VALIDATION',
          error.message,
        );
      }
      throw error;
    }
  },
};

const search: SearchGateway = {
  async search(query) {
    if (configuredSearch === null) {
      const apiKey = await secrets
        .resolveSecret(env.SEARCH_BRAVE_SECRET_REF)
        .catch(() => {
          throw new StepFailure('VALIDATION', '请在 .env 中配置 BRAVE_API_KEY');
        });
      configuredSearch = createBraveSearchGateway({
        apiKey,
        endpoint: env.SEARCH_BRAVE_ENDPOINT,
        proxyUrl: env.BRAVE_PROXY_URL,
      });
    }
    return configuredSearch.search(query);
  },
};

const businessHandlers = createBusinessHandlers({ db, llm, search });

const connection = createConnection(env.REDIS_URL);
const queues = createQueues(connection);
const llmConfigSubscriber: Redis = connection.duplicate();
let llmConfigInitialized = false;
let llmRefreshPending = false;
llmConfigSubscriber.on('error', (error) => {
  console.error('模型配置刷新订阅连接异常：', error.message);
});
llmConfigSubscriber.on('message', (channel) => {
  if (channel === LLM_MODELS_UPDATED_CHANNEL) {
    if (llmConfigInitialized) {
      void refreshLlmRuntimeCache();
    } else {
      llmRefreshPending = true;
    }
  }
});
await llmConfigSubscriber.subscribe(LLM_MODELS_UPDATED_CHANNEL);
llmRuntimeCache = await loadLlmRuntimeCache();
llmConfigInitialized = true;
if (llmRefreshPending) {
  await refreshLlmRuntimeCache();
}
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
    console.warn(
      `工作流步骤失败 ${JSON.stringify({
        occurredAt: new Date().toISOString(),
        runId: run.id,
        stepType: data.stepType,
        attemptNo: attempt.attemptNo,
        category,
        message,
      })}`,
    );
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
  console.error(
    `步骤任务失败 ${JSON.stringify({
      occurredAt: new Date().toISOString(),
      jobId: job?.id ?? null,
      runId: job?.data.runId ?? null,
      stepType: job?.data.stepType ?? null,
      attemptNo: job?.data.attemptNo ?? null,
    })}`,
    error,
  );
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
  await queues.close();
  await llmConfigSubscriber.quit();
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
