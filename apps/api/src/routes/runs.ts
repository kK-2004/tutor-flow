/**
 * 运行任务路由：创建（人工/调度）、列表/详情、选向、重试、取消。
 */
import { createHash } from 'node:crypto';

import type { WorkflowEngine } from '@tutor-flow/workflow';
import {
  appendAuditEvent,
  contentArtifacts,
  createRun,
  listEventsAfter,
  listRuns,
  listStepAttempts,
  listDirectionOptions,
  NotFoundError,
  platformAccounts,
  queryPlans,
  requireRun,
} from '@tutor-flow/db';
import type { DbClient } from '@tutor-flow/db';
import { isPlatform, PLATFORMS, RUN_STATUSES, XIAOHONGSHU } from '@tutor-flow/domain';
import type { ApiEnv } from '@tutor-flow/config/server';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

/** 宽松 UUID 形状校验（不校验版本位，测试夹具可用全零 id） */
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

import { isOperator, requireAuthenticated } from '../lib/auth.js';
import { parseBody } from '../lib/http.js';

/** 创建运行任务请求体 */
const createRunBodySchema = z
  .object({
    topic: z.string().trim().min(1).max(200),
    directionMode: z.enum(['auto', 'manual']),
    publishMode: z.enum(['review', 'auto']),
    platform: z.enum(PLATFORMS),
    accountId: z.string().regex(UUID_PATTERN, 'accountId 必须是 UUID'),
  })
  .strict();

/** 规范化载荷哈希（幂等冲突检测） */
function requestHashOf(body: z.infer<typeof createRunBodySchema>): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function tokenUsage(value: unknown): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
} {
  if (typeof value !== 'object' || value === null) {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }
  const record = value as Record<string, unknown>;
  const promptTokens =
    typeof record['promptTokens'] === 'number' ? record['promptTokens'] : 0;
  const completionTokens =
    typeof record['completionTokens'] === 'number' ? record['completionTokens'] : 0;
  const totalTokens =
    typeof record['totalTokens'] === 'number'
      ? record['totalTokens']
      : promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

/** 校验账号存在且为小红书账号 */
async function requireXiaohongshuAccount(db: DbClient, accountId: string): Promise<void> {
  const rows = await db.db
    .select({ id: platformAccounts.id, platform: platformAccounts.platform })
    .from(platformAccounts)
    .where(eq(platformAccounts.id, accountId))
    .limit(1);
  const account = rows[0];
  if (
    account === undefined ||
    !isPlatform(account.platform) ||
    account.platform !== XIAOHONGSHU
  ) {
    throw new NotFoundError(`小红书账号不存在：${accountId}`);
  }
}

export interface RunRoutesOptions {
  db: DbClient;
  engine: WorkflowEngine;
  env: ApiEnv;
}

export function registerRunRoutes(app: FastifyInstance, options: RunRoutesOptions): void {
  const { db, engine, env } = options;
  const authenticate = requireAuthenticated(env, db);

  // 创建运行任务（运营人员与外部调度器共用）
  app.post('/api/v1/runs', { preHandler: authenticate }, async (request, reply) => {
    const actor = request.actor;
    if (actor === undefined) {
      return reply.code(401).send({ error: '未认证' });
    }
    const body = parseBody(createRunBodySchema, request.body);
    await requireXiaohongshuAccount(db, body.accountId);

    const idempotencyHeader = request.headers['idempotency-key'];
    const idempotencyKey =
      typeof idempotencyHeader === 'string' && idempotencyHeader.trim() !== ''
        ? idempotencyHeader.trim()
        : undefined;

    if (actor.kind === 'scheduler' && idempotencyKey === undefined) {
      return reply.code(400).send({ error: '调度器触发必须携带 Idempotency-Key 头' });
    }

    const result = await createRun(db.db, {
      callerIdentity: actor.id,
      idempotencyKey,
      requestHash: requestHashOf(body),
      topic: body.topic,
      directionMode: body.directionMode,
      publishMode: body.publishMode,
      platform: XIAOHONGSHU,
      accountId: body.accountId,
      triggerType: actor.kind === 'scheduler' ? 'scheduler' : 'manual',
      triggeredBy: actor.id,
    });

    // 触发审计（幂等重放不重复审计）
    if (!result.replayed) {
      await appendAuditEvent(db.db, {
        actorType: actor.kind === 'scheduler' ? 'scheduler' : 'operator',
        actorId: actor.id,
        action: 'run.created',
        resourceType: 'workflow_run',
        resourceId: result.runId,
        runId: result.runId,
        payload: {
          topicLength: body.topic.length,
          directionMode: body.directionMode,
          publishMode: body.publishMode,
          platform: body.platform,
          hasIdempotencyKey: idempotencyKey !== undefined,
        },
      });
    }

    const run = await requireRun(db.db, result.runId);
    return reply
      .code(result.replayed ? 200 : 201)
      .header('x-idempotent-replay', result.replayed ? 'true' : 'false')
      .send({
        jobId: result.jobId,
        runId: result.runId,
        status: run.status,
        version: run.version,
        replayed: result.replayed,
      });
  });

  // 运行任务列表
  app.get('/api/v1/runs', { preHandler: authenticate }, async (request, reply) => {
    if (!isOperator(request.actor)) {
      return reply.code(403).send({ error: '仅运营人员可查看运行任务' });
    }
    const query = request.query as { status?: string; limit?: string; offset?: string };
    const limit = Math.min(Math.max(Number(query['limit'] ?? 20) || 20, 1), 100);
    const offset = Math.max(Number(query['offset'] ?? 0) || 0, 0);
    const statusFilter = query['status'];
    const status =
      statusFilter !== undefined &&
      (RUN_STATUSES as readonly string[]).includes(statusFilter)
        ? (statusFilter as (typeof RUN_STATUSES)[number])
        : undefined;
    const result = await listRuns(db.db, { status, limit, offset });
    return reply.send({
      items: result.items.map(({ run, job }) => ({
        runId: run.id,
        topic: job.topic,
        status: run.status,
        directionMode: job.directionMode,
        publishMode: job.publishMode,
        platform: job.platform,
        currentStepType: run.currentStepType,
        cancelRequested: run.cancelRequested,
        version: run.version,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      })),
      total: result.total,
      limit,
      offset,
    });
  });

  // 运行任务详情（含步骤尝试、候选方向与最近事件）
  app.get('/api/v1/runs/:id', { preHandler: authenticate }, async (request, reply) => {
    if (!isOperator(request.actor)) {
      return reply.code(403).send({ error: '仅运营人员可查看运行详情' });
    }
    const { id } = request.params as { id: string };
    const run = await requireRun(db.db, id).catch((error: unknown) => {
      if (error instanceof NotFoundError) {
        return null;
      }
      throw error;
    });
    if (run === null) {
      return reply.code(404).send({ error: `运行任务不存在：${id}` });
    }
    const steps = await listStepAttempts(db.db, id);
    const directions = await listDirectionOptions(db.db, id);
    const events = await listEventsAfter(db.db, id, undefined, 200);
    const [queryUsageRows, artifactRows] = await Promise.all([
      db.db
        .select({ queries: queryPlans.queries, usage: queryPlans.usage })
        .from(queryPlans)
        .where(eq(queryPlans.runId, id)),
      db.db
        .select({ generation: contentArtifacts.generation })
        .from(contentArtifacts)
        .where(eq(contentArtifacts.runId, id)),
    ]);
    const usage = queryUsageRows.reduce(
      (total, row) => {
        const item = tokenUsage(row.usage);
        return {
          searchQueries:
            total.searchQueries + (Array.isArray(row.queries) ? row.queries.length : 0),
          promptTokens: total.promptTokens + item.promptTokens,
          completionTokens: total.completionTokens + item.completionTokens,
          totalTokens: total.totalTokens + item.totalTokens,
        };
      },
      { searchQueries: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    );
    for (const row of artifactRows) {
      const generation =
        typeof row.generation === 'object' && row.generation !== null
          ? (row.generation as Record<string, unknown>)['tokenUsage']
          : undefined;
      const item = tokenUsage(generation);
      usage.promptTokens += item.promptTokens;
      usage.completionTokens += item.completionTokens;
      usage.totalTokens += item.totalTokens;
    }
    const humanGuidance =
      run.status === 'WAITING_DIRECTION'
        ? '请选择一个候选方向后继续。'
        : run.status === 'NEEDS_REVIEW'
          ? '请打开草稿箱，检查并批准当前修订。'
          : run.status === 'NEEDS_HUMAN'
            ? '请查看错误分类，完成授权、验证或策略处理后再继续。'
            : run.status === 'FAILED'
              ? '请检查失败步骤；仅瞬时错误允许安全重试。'
              : undefined;
    return reply.send({
      runId: run.id,
      status: run.status,
      currentStepType: run.currentStepType,
      cancelRequested: run.cancelRequested,
      version: run.version,
      humanWaitSince: run.humanWaitSince,
      humanGuidance,
      usage,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      steps: steps.map((step) => ({
        id: step.id,
        stepType: step.stepType,
        attemptNo: step.attemptNo,
        status: step.status,
        errorCategory: step.errorCategory,
        errorMessage: step.errorMessage,
        startedAt: step.startedAt,
        finishedAt: step.finishedAt,
      })),
      directions: directions.map((direction) => ({
        id: direction.id,
        title: direction.title,
        summary: direction.summary,
        targetAudience: direction.targetAudience,
        keywords: direction.keywords,
        totalScore: direction.totalScore,
        rank: direction.rank,
      })),
      events: events.map((event) => ({
        id: event.id,
        seq: event.seq,
        name: event.name,
        occurredAt: event.occurredAt,
        payload: event.payload,
      })),
    });
  });

  // 人工选择方向
  app.post(
    '/api/v1/runs/:id/direction-selection',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = request.actor;
      if (actor === undefined || actor.kind !== 'operator') {
        return reply.code(403).send({ error: '仅运营人员可选择方向' });
      }
      const { id } = request.params as { id: string };
      const body = parseBody(
        z
          .object({
            directionId: z.string().regex(UUID_PATTERN, 'directionId 必须是 UUID'),
            note: z.string().max(500).optional(),
          })
          .strict(),
        request.body,
      );
      await engine.resumeWithDirection(id, body.directionId, actor.id);
      const run = await requireRun(db.db, id);
      return reply.send({ runId: id, status: run.status, version: run.version });
    },
  );

  // 重试失败步骤
  app.post(
    '/api/v1/runs/:id/retry',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = request.actor;
      if (actor === undefined || actor.kind !== 'operator') {
        return reply.code(403).send({ error: '仅运营人员可重试' });
      }
      const { id } = request.params as { id: string };
      const body =
        request.body === undefined || request.body === null
          ? {}
          : parseBody(
              z.object({ reason: z.string().max(500).optional() }).strict(),
              request.body,
            );
      const result = await engine.retryStep(id, actor.id, body.reason);
      return reply.send({
        runId: id,
        retried: result.stepType,
        attemptNo: result.attemptNo,
      });
    },
  );

  // 取消运行
  app.post(
    '/api/v1/runs/:id/cancel',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = request.actor;
      if (!isOperator(actor)) {
        return reply.code(403).send({ error: '仅运营人员可取消运行任务' });
      }
      const { id } = request.params as { id: string };
      const body =
        request.body === undefined || request.body === null
          ? {}
          : parseBody(
              z.object({ reason: z.string().max(500).optional() }).strict(),
              request.body,
            );
      await engine.cancelRun(id, actor.id, body.reason);
      const run = await requireRun(db.db, id);
      return reply.send({ runId: id, status: run.status, version: run.version });
    },
  );
}
