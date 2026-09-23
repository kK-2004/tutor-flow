/**
 * 管理台控制面聚合路由：概览、研究资料、发布队列与非敏感设置。
 *
 * 所有返回值都经过业务视图裁剪，不把密钥引用、正文外部响应或 Cookie
 * 带到浏览器；写操作必须经过运营人员认证并产生审计事件。
 */
import {
  appendAuditEvent,
  getActivePlatformPolicy,
  getPublishJobDetails,
  findAccount,
  listPublishJobs,
  listRunSources,
  listSettings,
  requirePublishJob,
  updatePublishJobStatus,
  updateReceiptVerification,
  findReceiptByJob,
  type DbClient,
} from '@tutor-flow/db';
import {
  parseXiaohongshuPolicy,
  parseContentCenterSettings,
  type QualityThresholds,
  type SearchBudget,
  type XiaohongshuPolicy,
} from '@tutor-flow/domain';
import type { PublisherAdapter } from '@tutor-flow/integrations';
import type { SecretProvider } from '@tutor-flow/config/server';
import { count, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  auditEvents,
  contentArtifacts,
  draftRevisions,
  outboxRecords,
  platformPolicies,
  publishJobs,
  queryPlans,
  workflowRuns,
} from '@tutor-flow/db';
import { requireAuthenticated } from '../lib/auth.js';
import { parseBody } from '../lib/http.js';

export interface OperationsRoutesOptions {
  db: DbClient;
  env: import('@tutor-flow/config/server').ApiEnv;
  adapter?: PublisherAdapter | null;
  secrets?: SecretProvider | null;
}

const operatorOnly = (actor: { kind: string } | undefined): boolean =>
  actor?.kind === 'operator';

function safeSetting(key: string, value: unknown, version: number, updatedAt: Date) {
  return { key, value, version, updatedAt };
}

function sumTokenUsage(value: unknown): number {
  if (typeof value !== 'object' || value === null) {
    return 0;
  }
  const record = value as Record<string, unknown>;
  const prompt = typeof record['promptTokens'] === 'number' ? record['promptTokens'] : 0;
  const completion =
    typeof record['completionTokens'] === 'number' ? record['completionTokens'] : 0;
  const total = typeof record['totalTokens'] === 'number' ? record['totalTokens'] : 0;
  return total > 0 ? total : prompt + completion;
}

/** 注册管理台所需的聚合查询与操作。 */
export function registerOperationsRoutes(
  app: FastifyInstance,
  options: OperationsRoutesOptions,
): void {
  const { db, env } = options;
  const authenticate = requireAuthenticated(env, db);

  app.get('/api/v1/overview', { preHandler: authenticate }, async (_request, reply) => {
    const [
      running,
      drafts,
      publishQueue,
      queryUsage,
      artifactUsage,
      activity,
      loginAccount,
    ] = await Promise.all([
      db.db
        .select({ value: count() })
        .from(workflowRuns)
        .where(
          inArray(workflowRuns.status, [
            'QUEUED',
            'RESEARCHING',
            'WAITING_DIRECTION',
            'GENERATING',
            'MODERATING',
            'NEEDS_REVIEW',
            'PUBLISHING',
            'RETRY_WAIT',
            'NEEDS_HUMAN',
          ]),
        ),
      db.db
        .select({ value: count() })
        .from(draftRevisions)
        .where(eq(draftRevisions.status, 'PENDING_REVIEW')),
      db.db
        .select({ value: count() })
        .from(publishJobs)
        .where(
          inArray(publishJobs.status, [
            'QUEUED',
            'PUBLISHING',
            'FAILED',
            'UNKNOWN_OUTCOME',
            'NEEDS_HUMAN',
          ]),
        ),
      db.db
        .select({ queries: queryPlans.queries, usage: queryPlans.usage })
        .from(queryPlans),
      db.db.select({ generation: contentArtifacts.generation }).from(contentArtifacts),
      db.db.select().from(auditEvents).orderBy(desc(auditEvents.occurredAt)).limit(12),
      env.XHS_MCP_ACCOUNT_ID === undefined
        ? Promise.resolve(null)
        : findAccount(db.db, env.XHS_MCP_ACCOUNT_ID),
    ]);
    return reply.send({
      updatedAt: new Date().toISOString(),
      loginAccount: {
        bound: env.XHS_MCP_ACCOUNT_ID !== undefined,
        mcpConfigured: env.XHS_MCP_URL !== undefined,
        account:
          loginAccount === null
            ? null
            : {
                id: loginAccount.id,
                alias: loginAccount.alias,
                health: loginAccount.health,
                lastAuthCheckAt: loginAccount.lastAuthCheckAt,
              },
      },
      metrics: {
        runningRuns: running[0]?.value ?? 0,
        pendingDrafts: drafts[0]?.value ?? 0,
        pendingPublishes: publishQueue[0]?.value ?? 0,
        searchQueries: queryUsage.reduce(
          (total, item) =>
            total + (Array.isArray(item.queries) ? item.queries.length : 0),
          0,
        ),
        tokenUsage:
          queryUsage.reduce((total, item) => total + sumTokenUsage(item.usage), 0) +
          artifactUsage.reduce((total, item) => {
            const generation =
              typeof item.generation === 'object' && item.generation !== null
                ? (item.generation as Record<string, unknown>)['tokenUsage']
                : undefined;
            return total + sumTokenUsage(generation);
          }, 0),
      },
      recentActivity: activity.map((item) => ({
        id: item.id,
        occurredAt: item.occurredAt,
        actorType: item.actorType,
        action: item.action,
        resourceType: item.resourceType,
        resourceId: item.resourceId,
        runId: item.runId,
        publishJobId: item.publishJobId,
      })),
    });
  });

  app.get(
    '/api/v1/runs/:id/sources',
    { preHandler: authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await listRunSources(db.db, id);
      return reply.send({
        sources: result.sources.map((source) => ({
          id: source.id,
          canonicalUrl: source.canonicalUrl,
          title: source.title,
          domain: source.domain,
          language: source.language,
          sourceType: source.sourceType,
          fetchStatus: source.fetchStatus,
          fetchNote: source.fetchNote,
          publishedAt: source.publishedAt,
          isPrimary: source.isPrimary,
          clusterId: source.clusterId,
          clusterRole: source.clusterRole,
          scoreFactors: source.scoreFactors,
          totalScore: source.totalScore,
        })),
        claims: result.claims.map((claim) => ({
          id: claim.id,
          statement: claim.statement,
          confidence: claim.confidence,
          primarySourceSupported: claim.primarySourceSupported,
          usedIn: claim.usedIn,
          sourceIds: claim.sourceIds,
        })),
      });
    },
  );

  app.get(
    '/api/v1/publish-jobs',
    { preHandler: authenticate },
    async (request, reply) => {
      const query = request.query as { status?: string; limit?: string; offset?: string };
      const statuses = [
        'QUEUED',
        'PUBLISHING',
        'SUCCEEDED',
        'FAILED',
        'UNKNOWN_OUTCOME',
        'NEEDS_HUMAN',
        'CANCELLED',
      ] as const;
      const status = statuses.includes(query['status'] as never)
        ? (query['status'] as (typeof statuses)[number])
        : undefined;
      const result = await listPublishJobs(db.db, {
        status,
        limit: Math.min(Math.max(Number(query['limit'] ?? 50) || 50, 1), 100),
        offset: Math.max(Number(query['offset'] ?? 0) || 0, 0),
      });
      return reply.send({
        total: result.total,
        items: result.items.map(({ job, account, draft, receipt }) => ({
          id: job.id,
          runId: job.runId,
          status: job.status,
          attempts: job.attempts,
          account: { id: account.id, alias: account.alias, health: account.health },
          content: { revision: draft.revision, title: draft.title },
          error: job.lastError,
          receipt:
            receipt === null
              ? null
              : {
                  platformPostId: receipt.platformPostId,
                  platformUrl: receipt.platformUrl,
                  verification: receipt.verification,
                  publishedAt: receipt.publishedAt,
                },
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
        })),
      });
    },
  );

  app.get(
    '/api/v1/publish-jobs/:id',
    { preHandler: authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const details = await getPublishJobDetails(db.db, id);
      if (details === null) {
        return reply.code(404).send({ error: `发布任务不存在：${id}` });
      }
      return reply.send({
        id: details.job.id,
        runId: details.job.runId,
        status: details.job.status,
        attempts: details.job.attempts,
        error: details.job.lastError,
        account: {
          id: details.account.id,
          alias: details.account.alias,
          health: details.account.health,
        },
        draft: {
          revision: details.draft.revision,
          title: details.draft.title,
          body: details.draft.body,
          tags: details.draft.tags,
          mediaObjectKeys: details.draft.mediaObjectKeys,
        },
        receipt: details.receipt,
        createdAt: details.job.createdAt,
        updatedAt: details.job.updatedAt,
      });
    },
  );

  app.post(
    '/api/v1/publish-jobs/:id/retry',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = request.actor;
      if (!operatorOnly(actor)) {
        return reply.code(403).send({ error: '仅运营人员可重试发布任务' });
      }
      const { id } = request.params as { id: string };
      const body = parseBody(
        z.object({ reason: z.string().trim().max(500).optional() }).strict(),
        request.body ?? {},
      );
      const job = await requirePublishJob(db.db, id);
      const error = job.lastError as { category?: string; message?: string } | null;
      if (
        job.status !== 'FAILED' ||
        !['TRANSIENT', 'RATE_LIMITED'].includes(error?.category ?? '')
      ) {
        return reply.code(409).send({
          error: '当前发布任务不是可安全重试的瞬时失败',
          guidance: '请先完成授权、验证或未知结果核验',
        });
      }
      await updatePublishJobStatus(db.db, id, 'QUEUED', { clearError: true });
      await db.db.insert(outboxRecords).values({
        eventName: 'publish.retry',
        aggregateType: 'publish_job',
        aggregateId: id,
        payload: {
          job: {
            queue: 'publishing',
            name: 'publish-job',
            data: {
              publishJobId: id,
              accountId: job.accountId,
              idempotencyKey: job.idempotencyKey,
            },
          },
        },
      });
      await appendAuditEvent(db.db, {
        actorType: 'operator',
        actorId: actor?.id ?? 'operator',
        action: 'publish.retried',
        resourceType: 'publish_job',
        resourceId: id,
        runId: job.runId,
        publishJobId: id,
        payload: { reason: body.reason, previousCategory: error?.category },
      });
      return reply.send({ id, status: 'QUEUED' });
    },
  );

  app.post(
    '/api/v1/publish-jobs/:id/verify',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = request.actor;
      if (!operatorOnly(actor)) {
        return reply.code(403).send({ error: '仅运营人员可执行发布核验' });
      }
      if (
        options.adapter === null ||
        options.adapter === undefined ||
        (options.adapter.sessionMode !== 'sidecar' &&
          (options.secrets === null || options.secrets === undefined))
      ) {
        return reply.code(503).send({ error: '发布适配器未配置' });
      }
      if (options.adapter.sessionMode === 'sidecar') {
        return reply.code(409).send({
          error: '上游 MCP 未提供按笔记 ID 自动核验接口，请人工确认发布结果',
        });
      }
      const { id } = request.params as { id: string };
      const details = await getPublishJobDetails(db.db, id);
      if (details === null) {
        return reply.code(404).send({ error: `发布任务不存在：${id}` });
      }
      const receipt = await findReceiptByJob(db.db, id);
      if (receipt === null) {
        return reply.code(409).send({ error: '任务没有可核验的发布回执，禁止盲目重发' });
      }
      const secretValue = await options.secrets!.resolveSecret(details.account.secretRef);
      const status = await options.adapter.queryStatus(
        { accountId: details.account.id, alias: details.account.alias, secretValue },
        receipt.platformPostId,
      );
      if (status.exists) {
        await updateReceiptVerification(db.db, id, 'VERIFIED', status.url, status.note);
        await updatePublishJobStatus(db.db, id, 'SUCCEEDED');
      } else {
        await updateReceiptVerification(
          db.db,
          id,
          'MISSING',
          undefined,
          status.note ?? '平台侧未找到内容',
        );
        await updatePublishJobStatus(db.db, id, 'NEEDS_HUMAN', {
          lastError: { category: 'UNKNOWN_OUTCOME', message: '核验未找到平台内容' },
        });
      }
      await appendAuditEvent(db.db, {
        actorType: 'operator',
        actorId: actor?.id ?? 'operator',
        action: 'publish.verified',
        resourceType: 'publish_job',
        resourceId: id,
        runId: details.job.runId,
        publishJobId: id,
        payload: { exists: status.exists },
      });
      return reply.send({
        id,
        exists: status.exists,
        status: status.exists ? 'SUCCEEDED' : 'NEEDS_HUMAN',
      });
    },
  );

  app.get('/api/v1/settings', { preHandler: authenticate }, async (_request, reply) => {
    const [settings, policy] = await Promise.all([
      listSettings(db.db),
      getActivePlatformPolicy(db.db),
    ]);
    return reply.send({
      items: settings.map((item) =>
        safeSetting(item.key, item.value, item.version, item.updatedAt),
      ),
      policy: { version: policy.version, policy: policy.policy },
      secrets: {
        schedulerToken:
          env.SCHEDULER_TOKEN === undefined ? 'not_configured' : 'configured',
        operatorToken: env.OPERATOR_TOKEN === undefined ? 'not_configured' : 'configured',
        contentCenterToken:
          options.secrets !== null &&
          options.secrets !== undefined &&
          (await options.secrets.hasSecret(env.CONTENT_CENTER_TOKEN_REF))
            ? 'configured'
            : 'not_configured',
      },
      connections: {
        database: 'configured',
        redis: env.REDIS_URL === '' ? 'not_configured' : 'configured',
        publisher:
          options.adapter !== null && options.adapter !== undefined
            ? 'configured'
            : 'disabled',
        contentCenter:
          env.CONTENT_CENTER_URL === undefined ? 'not_configured' : 'configured',
      },
    });
  });

  app.patch(
    '/api/v1/settings/:key',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = request.actor;
      if (!operatorOnly(actor)) {
        return reply.code(403).send({ error: '仅运营人员可修改系统设置' });
      }
      const { key } = request.params as { key: string };
      const body = parseBody(
        z
          .object({
            value: z.unknown(),
            expectedVersion: z.number().int().positive().optional(),
          })
          .strict(),
        request.body,
      );
      let value: unknown;
      try {
        value = validateSettingValue(key, body.value);
      } catch (error) {
        return reply
          .code(400)
          .send({ error: error instanceof Error ? error.message : '设置值无效' });
      }
      const { upsertSetting } = await import('@tutor-flow/db');
      const saved = await upsertSetting(db.db, {
        key,
        value,
        expectedVersion: body.expectedVersion,
        updatedBy: actor?.id ?? 'operator',
      });
      await appendAuditEvent(db.db, {
        actorType: 'operator',
        actorId: actor?.id ?? 'operator',
        action: 'setting.updated',
        resourceType: 'system_setting',
        resourceId: key,
        payload: { version: saved.version },
      });
      return reply.send(
        safeSetting(saved.key, saved.value, saved.version, saved.updatedAt),
      );
    },
  );

  app.put(
    '/api/v1/settings/xiaohongshu-policy',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = request.actor;
      if (!operatorOnly(actor)) {
        return reply.code(403).send({ error: '仅运营人员可更新平台策略' });
      }
      let policy: XiaohongshuPolicy;
      try {
        policy = parseXiaohongshuPolicy(request.body);
      } catch (error) {
        return reply
          .code(400)
          .send({ error: error instanceof Error ? error.message : '平台策略无效' });
      }
      await db.db.transaction(async (tx) => {
        await tx
          .update(platformPolicies)
          .set({ isActive: false })
          .where(eq(platformPolicies.platform, 'xiaohongshu'));
        await tx
          .insert(platformPolicies)
          .values({
            platform: 'xiaohongshu',
            version: policy.policyVersion,
            policy,
            isActive: true,
            createdBy: actor?.id ?? 'operator',
          })
          .onConflictDoUpdate({
            target: [platformPolicies.platform, platformPolicies.version],
            set: { policy, isActive: true, createdBy: actor?.id ?? 'operator' },
          });
      });
      await appendAuditEvent(db.db, {
        actorType: 'operator',
        actorId: actor?.id ?? 'operator',
        action: 'platform_policy.updated',
        resourceType: 'platform_policy',
        resourceId: policy.policyVersion,
        payload: { version: policy.policyVersion },
      });
      return reply.send({ version: policy.policyVersion, policy });
    },
  );
}

/** 设置值的服务端范围校验，尤其禁止关闭强制人工审核。 */
function validateSettingValue(key: string, value: unknown): unknown {
  if (key === 'content_center') {
    return parseContentCenterSettings(value);
  }
  if (key === 'quality_thresholds') {
    const parsed = value as Partial<QualityThresholds>;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.minSourceCoverage !== 'number' ||
      parsed.minSourceCoverage < 0 ||
      parsed.minSourceCoverage > 1 ||
      typeof parsed.minPrimarySources !== 'number' ||
      parsed.minPrimarySources < 1 ||
      typeof parsed.minDirectionScore !== 'number' ||
      parsed.minDirectionScore < 0 ||
      parsed.minDirectionScore > 100 ||
      typeof parsed.maxRisk !== 'number' ||
      parsed.maxRisk < 0 ||
      parsed.maxRisk > 1 ||
      typeof parsed.minSourceTotalScore !== 'number' ||
      parsed.minSourceTotalScore < 0 ||
      parsed.minSourceTotalScore > 100
    ) {
      throw new Error('质量门槛范围无效');
    }
    return parsed;
  }
  if (key === 'search_budget') {
    const parsed = value as Partial<SearchBudget>;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.maxQueries !== 'number' ||
      parsed.maxQueries < 1 ||
      parsed.maxQueries > 50 ||
      typeof parsed.maxResultsPerQuery !== 'number' ||
      parsed.maxResultsPerQuery < 1 ||
      parsed.maxResultsPerQuery > 100 ||
      typeof parsed.maxFetches !== 'number' ||
      parsed.maxFetches < 1 ||
      parsed.maxFetches > 200
    ) {
      throw new Error('搜索预算范围无效');
    }
    return parsed;
  }
  if (key === 'publish_guards') {
    const parsed = value as {
      requireHumanApproval?: unknown;
      defaultReviewMode?: unknown;
    };
    if (parsed.requireHumanApproval !== true) {
      throw new Error('首期不允许关闭强制人工批准');
    }
    return {
      defaultReviewMode: parsed.defaultReviewMode === 'auto' ? 'auto' : 'review',
      requireHumanApproval: true,
    };
  }
  if (key === 'model_aliases') {
    if (typeof value !== 'object' || value === null) {
      throw new Error('模型别名必须是对象');
    }
    return value;
  }
  throw new Error(`不允许修改设置：${key}`);
}
