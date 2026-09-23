/**
 * API 应用工厂：构建可测试的 Fastify 实例。
 */
import {
  contentArtifacts,
  createDb,
  outboxRecords,
  platformAccounts,
  publishJobs,
  queryPlans,
  stepRuns,
  workflowRuns,
  type DbClient,
} from '@tutor-flow/db';
import { loadApiEnv, resolveDatabasePath, type ApiEnv } from '@tutor-flow/config/server';
import {
  createMcpPublisherAdapter,
  createHttpMcpToolCaller,
} from '@tutor-flow/integrations';
import { createWorkflowEngine, type WorkflowEngine } from '@tutor-flow/workflow';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';

import { mapHttpError } from './lib/http.js';
import { EnvSecretProvider } from '@tutor-flow/config/server';
import { registerRunRoutes } from './routes/runs.js';
import { registerAccountRoutes } from './routes/accounts.js';
import { registerDraftRoutes } from './routes/drafts.js';
import { registerSseRoutes } from './routes/sse.js';
import { registerOperationsRoutes } from './routes/operations.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerAdminAuthRoutes } from './routes/admin-auth.js';
import { createMetrics, startSpan } from '@tutor-flow/observability';

export interface BuildAppOptions {
  /** 缺省时从环境变量加载并创建数据库客户端（测试时可注入替代实现） */
  db?: DbClient;
  env?: ApiEnv;
}

export interface AppHandle {
  app: FastifyInstance;
  db: DbClient;
  engine: WorkflowEngine;
}

/** 构建已注册全部路由的 Fastify 实例（不监听端口） */
export async function buildApp(options: BuildAppOptions = {}): Promise<AppHandle> {
  const env = options.env ?? loadApiEnv();
  const db =
    options.db ??
    createDb({
      path: resolveDatabasePath(env.SQLITE_PATH),
      applicationName: 'tutor-flow-api',
    });
  const engine = createWorkflowEngine(db);

  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
    // 请求体大小限制：主题与说明均较短，默认 1MiB 足够
    bodyLimit: 1024 * 1024,
  });
  const metrics = createMetrics();
  const requestStarts = new Map<string, number>();
  app.addHook('onRequest', async (request, reply) => {
    requestStarts.set(request.id, Date.now());
    const span = startSpan('api.request', undefined, {
      method: request.method,
      path: request.url,
    });
    reply.header('x-trace-id', span.context.traceId);
    metrics.increment('api_requests_total');
  });
  app.addHook('onResponse', async (request) => {
    const startedAt = requestStarts.get(request.id);
    if (startedAt !== undefined) {
      metrics.observe('api_request_duration_ms', Date.now() - startedAt);
      requestStarts.delete(request.id);
    }
  });

  // 统一安全响应头；富文本预览不允许加载第三方脚本或嵌入页面。
  app.addHook('onSend', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header(
      'content-security-policy',
      "default-src 'self'; script-src 'none'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
  });

  app.setErrorHandler((error, request, reply) => {
    mapHttpError(error, request, reply);
  });

  // 存活探针
  app.get('/healthz', async () => ({ status: 'ok' }));
  // 就绪探针：数据库可达
  app.get('/readyz', async () => {
    try {
      await db.client.execute('SELECT 1');
      return { status: 'ready' };
    } catch {
      return { status: 'degraded' };
    }
  });
  app.get('/metrics', async (_request, reply) => {
    const [runs, publishes, accounts, plans, artifacts, steps, outbox] =
      await Promise.all([
        db.db.select().from(workflowRuns),
        db.db.select().from(publishJobs),
        db.db.select().from(platformAccounts),
        db.db
          .select({ queries: queryPlans.queries, usage: queryPlans.usage })
          .from(queryPlans),
        db.db.select({ generation: contentArtifacts.generation }).from(contentArtifacts),
        db.db
          .select({
            status: stepRuns.status,
            startedAt: stepRuns.startedAt,
            finishedAt: stepRuns.finishedAt,
          })
          .from(stepRuns),
        db.db
          .select({
            createdAt: outboxRecords.createdAt,
            dispatchedAt: outboxRecords.dispatchedAt,
          })
          .from(outboxRecords),
      ]);
    const tokenUsage = (value: unknown): number => {
      if (typeof value !== 'object' || value === null) return 0;
      const record = value as Record<string, unknown>;
      const total = typeof record['totalTokens'] === 'number' ? record['totalTokens'] : 0;
      const prompt =
        typeof record['promptTokens'] === 'number' ? record['promptTokens'] : 0;
      const completion =
        typeof record['completionTokens'] === 'number' ? record['completionTokens'] : 0;
      return total > 0 ? total : prompt + completion;
    };
    const searchQueries = plans.reduce(
      (total, item) => total + (Array.isArray(item.queries) ? item.queries.length : 0),
      0,
    );
    const modelTokens =
      plans.reduce((total, item) => total + tokenUsage(item.usage), 0) +
      artifacts.reduce((total, item) => {
        const generation =
          typeof item.generation === 'object' && item.generation !== null
            ? (item.generation as Record<string, unknown>)['tokenUsage']
            : undefined;
        return total + tokenUsage(generation);
      }, 0);
    metrics.set(
      'workflow_running',
      runs.filter((run) => !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.status))
        .length,
    );
    metrics.set(
      'workflow_human_waiting',
      runs.filter((run) =>
        ['WAITING_DIRECTION', 'NEEDS_REVIEW', 'NEEDS_HUMAN'].includes(run.status),
      ).length,
    );
    metrics.set(
      'publish_queue_depth',
      publishes.filter((job) =>
        ['QUEUED', 'PUBLISHING', 'FAILED', 'UNKNOWN_OUTCOME', 'NEEDS_HUMAN'].includes(
          job.status,
        ),
      ).length,
    );
    metrics.set(
      'publish_succeeded_total',
      publishes.filter((job) => job.status === 'SUCCEEDED').length,
    );
    metrics.set('search_queries_total', searchQueries);
    metrics.set('model_tokens_total', modelTokens);
    metrics.set(
      'account_needs_human',
      accounts.filter((account) => account.needsHumanAttention).length,
    );
    metrics.set(
      'account_auth_required',
      accounts.filter((account) =>
        ['AUTH_REQUIRED', 'CHALLENGE_REQUIRED'].includes(account.health),
      ).length,
    );
    metrics.set(
      'outbox_pending',
      outbox.filter((item) => item.dispatchedAt === null).length,
    );
    const finishedSteps = steps.filter(
      (step) => step.startedAt !== null && step.finishedAt !== null,
    );
    metrics.set(
      'workflow_step_failures_total',
      steps.filter((step) => step.status === 'FAILED').length,
    );
    if (finishedSteps.length > 0) {
      metrics.observe(
        'workflow_step_duration_ms',
        finishedSteps.reduce(
          (total, step) =>
            total + (step.finishedAt?.getTime() ?? 0) - (step.startedAt?.getTime() ?? 0),
          0,
        ) / finishedSteps.length,
      );
    }
    const pendingOutbox = outbox.filter((item) => item.dispatchedAt === null);
    if (pendingOutbox.length > 0) {
      metrics.observe(
        'outbox_oldest_wait_ms',
        Date.now() - Math.min(...pendingOutbox.map((item) => item.createdAt.getTime())),
      );
    }
    const snapshot = metrics.snapshot();
    const lines = [
      ...Object.entries(snapshot.counters).map(([name, value]) => `${name} ${value}`),
      ...Object.entries(snapshot.gauges).map(([name, value]) => `${name} ${value}`),
      ...Object.entries(snapshot.histograms).flatMap(([name, value]) => [
        `${name}_count ${value.count}`,
        `${name}_sum ${value.sum}`,
        `${name}_max ${value.max}`,
      ]),
    ];
    return reply.type('text/plain; version=0.0.4').send(`${lines.join('\n')}\n`);
  });

  // 发布适配器：地址与唯一账号都配置后装配，避免误读其他账号的容器登录态。
  const mcpUrl = env.XHS_MCP_URL;
  const mcpAccountId = env.XHS_MCP_ACCOUNT_ID;
  const mcpAuthTokenRef = env.XHS_MCP_AUTH_TOKEN_REF;
  const mcpSecrets = new EnvSecretProvider();
  const mcpCallTool =
    mcpUrl === undefined
      ? null
      : createHttpMcpToolCaller(
          mcpUrl,
          60_000,
          mcpAuthTokenRef ? () => mcpSecrets.resolveSecret(mcpAuthTokenRef) : undefined,
        );
  const adapter =
    mcpCallTool !== null && mcpAccountId !== undefined
      ? createMcpPublisherAdapter({
          boundAccountId: mcpAccountId,
          callTool: mcpCallTool,
        })
      : null;

  registerAdminAuthRoutes(app, { db, env });
  registerRunRoutes(app, { db, engine, env });
  registerDraftRoutes(app, { db, env });
  registerMediaRoutes(app, { db, env });
  registerAccountRoutes(app, {
    db,
    env,
    adapter,
    mcpCallTool,
    secrets: new EnvSecretProvider(),
  });
  registerSseRoutes(app, { db, env });
  registerOperationsRoutes(app, {
    db,
    env,
    adapter,
    secrets: new EnvSecretProvider(),
  });

  return { app, db, engine };
}
