/**
 * 管理台控制面聚合路由：概览、研究资料、发布队列与非敏感设置。
 *
 * 所有返回值都经过业务视图裁剪，不把密钥引用、正文外部响应或 Cookie
 * 带到浏览器；写操作必须经过运营人员认证并产生审计事件。
 */
import {
  appendAuditEvent,
  getSetting,
  getActivePlatformPolicy,
  getRunWithJob,
  listRunSources,
  listSettings,
  type DbClient,
} from '@tutor-flow/db';
import {
  LLM_TASKS,
  PLATFORM_OPTIONS,
  parseXiaohongshuPolicy,
  parseContentCenterSettings,
  type QualityThresholds,
  type SearchBudget,
  type LlmModelsConfig,
  type ContentPromptsConfig,
  type XiaohongshuPolicy,
} from '@tutor-flow/domain';
import {
  encryptLocalSecret,
  resolveDatabasePath,
  type SecretProvider,
} from '@tutor-flow/config/server';
import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  workflowEvents,
  contentArtifacts,
  draftRevisions,
  platformPolicies,
  queryPlans,
  workflowRuns,
  researchFolders,
  researchDocuments,
} from '@tutor-flow/db';
import { requireAuthenticated } from '../lib/auth.js';
import { parseBody } from '../lib/http.js';

export interface OperationsRoutesOptions {
  db: DbClient;
  env: import('@tutor-flow/config/server').ApiEnv;
  secrets?: SecretProvider | null;
  publishLlmModelsUpdate?: () => Promise<void>;
}

const operatorOnly = (actor: { kind: string } | undefined): boolean =>
  actor?.kind === 'operator';

function safeSetting(key: string, value: unknown, version: number, updatedAt: Date) {
  let safeValue = value;
  if (key === 'llm_models' && typeof value === 'object' && value !== null) {
    const config = value as LlmModelsConfig;
    safeValue = {
      ...config,
      providers: config.providers.map((provider) => {
        const { apiKeyEncrypted, ...visibleProvider } = provider;
        return { ...visibleProvider, hasApiKey: Boolean(apiKeyEncrypted) };
      }),
    };
  }
  return { key, value: safeValue, version, updatedAt };
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

  app.get(
    '/api/v1/research-library',
    { preHandler: authenticate },
    async (_request, reply) => {
      const [folders, documents] = await Promise.all([
        db.db.select().from(researchFolders),
        db.db.select().from(researchDocuments).orderBy(desc(researchDocuments.updatedAt)),
      ]);
      return reply.send({ folders, documents });
    },
  );

  app.post(
    '/api/v1/research-library/folders',
    { preHandler: authenticate },
    async (request, reply) => {
      if (!operatorOnly(request.actor))
        return reply.code(403).send({ error: '仅运营人员可管理研究资料' });
      const body = parseBody(
        z
          .object({
            name: z.string().trim().min(1).max(100),
            parentId: z.string().nullable().optional(),
          })
          .strict(),
        request.body,
      );
      const [folder] = await db.db.insert(researchFolders).values(body).returning();
      return reply.code(201).send(folder);
    },
  );

  app.patch(
    '/api/v1/research-library/folders/:id',
    { preHandler: authenticate },
    async (request, reply) => {
      if (!operatorOnly(request.actor))
        return reply.code(403).send({ error: '仅运营人员可管理研究资料' });
      const { id } = request.params as { id: string };
      const body = parseBody(
        z.object({ name: z.string().trim().min(1).max(100) }).strict(),
        request.body,
      );
      const [folder] = await db.db
        .update(researchFolders)
        .set(body)
        .where(eq(researchFolders.id, id))
        .returning();
      return folder
        ? reply.send(folder)
        : reply.code(404).send({ error: '文件夹不存在' });
    },
  );

  app.delete(
    '/api/v1/research-library/folders/:id',
    { preHandler: authenticate },
    async (request, reply) => {
      if (!operatorOnly(request.actor))
        return reply.code(403).send({ error: '仅运营人员可管理研究资料' });
      const { id } = request.params as { id: string };
      const folders = await db.db.select().from(researchFolders);
      const folderIds = new Set([id]);
      let added = true;
      while (added) {
        added = false;
        for (const folder of folders) {
          if (
            folder.parentId !== null &&
            folderIds.has(folder.parentId) &&
            !folderIds.has(folder.id)
          ) {
            folderIds.add(folder.id);
            added = true;
          }
        }
      }
      await db.db.transaction(async (tx) => {
        await tx
          .delete(researchDocuments)
          .where(inArray(researchDocuments.folderId, [...folderIds]));
        await tx
          .delete(researchFolders)
          .where(inArray(researchFolders.id, [...folderIds]));
      });
      return reply.code(204).send();
    },
  );

  app.post(
    '/api/v1/research-library/documents',
    { preHandler: authenticate },
    async (request, reply) => {
      if (!operatorOnly(request.actor))
        return reply.code(403).send({ error: '仅运营人员可管理研究资料' });
      const body = parseBody(
        z
          .object({
            title: z.string().trim().min(1).max(200),
            markdown: z.string().max(500000),
            folderId: z.string().nullable().optional(),
          })
          .strict(),
        request.body,
      );
      const [document] = await db.db.insert(researchDocuments).values(body).returning();
      return reply.code(201).send(document);
    },
  );

  app.patch(
    '/api/v1/research-library/documents/:id',
    { preHandler: authenticate },
    async (request, reply) => {
      if (!operatorOnly(request.actor))
        return reply.code(403).send({ error: '仅运营人员可管理研究资料' });
      const { id } = request.params as { id: string };
      const body = parseBody(
        z
          .object({
            title: z.string().trim().min(1).max(200),
            markdown: z.string().max(500000),
            folderId: z.string().nullable(),
          })
          .strict(),
        request.body,
      );
      const [document] = await db.db
        .update(researchDocuments)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(researchDocuments.id, id))
        .returning();
      return document
        ? reply.send(document)
        : reply.code(404).send({ error: '研究资料不存在' });
    },
  );

  app.delete(
    '/api/v1/research-library/documents',
    { preHandler: authenticate },
    async (request, reply) => {
      if (!operatorOnly(request.actor))
        return reply.code(403).send({ error: '仅运营人员可管理研究资料' });
      const body = parseBody(
        z.object({ ids: z.array(z.string()).min(1).max(500) }).strict(),
        request.body,
      );
      await db.db
        .delete(researchDocuments)
        .where(inArray(researchDocuments.id, body.ids));
      return reply.code(204).send();
    },
  );

  app.get('/api/v1/overview', { preHandler: authenticate }, async (_request, reply) => {
    const [running, drafts, queryUsage, artifactUsage, activity] = await Promise.all([
      db.db
        .select({ value: count() })
        .from(workflowRuns)
        .where(
          and(
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
            isNull(workflowRuns.deletedAt),
          ),
        ),
      db.db
        .select({ value: count() })
        .from(draftRevisions)
        .innerJoin(workflowRuns, eq(draftRevisions.runId, workflowRuns.id))
        .where(
          and(
            eq(draftRevisions.status, 'PENDING_REVIEW'),
            isNull(draftRevisions.deletedAt),
            isNull(workflowRuns.deletedAt),
          ),
        ),
      db.db
        .select({ queries: queryPlans.queries, usage: queryPlans.usage })
        .from(queryPlans),
      db.db.select({ generation: contentArtifacts.generation }).from(contentArtifacts),
      db.db
        .select({ event: workflowEvents, runId: workflowRuns.id })
        .from(workflowEvents)
        .innerJoin(workflowRuns, eq(workflowEvents.runId, workflowRuns.id))
        .where(isNull(workflowRuns.deletedAt))
        .orderBy(desc(workflowEvents.occurredAt), desc(workflowEvents.id))
        .limit(12),
    ]);
    return reply.send({
      updatedAt: new Date().toISOString(),
      metrics: {
        runningRuns: running[0]?.value ?? 0,
        pendingDrafts: drafts[0]?.value ?? 0,
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
      recentActivity: activity.map(({ event, runId }) => ({
        id: event.id,
        occurredAt: event.occurredAt,
        actorType: 'workflow',
        action: event.name,
        resourceType: '任务',
        resourceId: runId,
        runId,
        payload: event.payload,
      })),
    });
  });

  app.get(
    '/api/v1/runs/:id/sources',
    { preHandler: authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if ((await getRunWithJob(db.db, id)) === null) {
        return reply.code(404).send({ error: `运行任务不存在：${id}` });
      }
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
      if (key === 'content_center' && actor?.role !== 'SUPER_ADMIN') {
        return reply.code(403).send({ error: '仅超级管理员可修改内容中心设置' });
      }
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
        if (key === 'llm_models') {
          const input = validateLlmModelsInput(body.value);
          const existing = await getSetting(db.db, key);
          const existingConfig = existing?.value as LlmModelsConfig | undefined;
          value = await persistLlmModels(
            input,
            existingConfig,
            resolveDatabasePath(env.SQLITE_PATH),
          );
        } else {
          value = validateSettingValue(key, body.value);
        }
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
      if (key === 'llm_models' && options.publishLlmModelsUpdate) {
        try {
          await options.publishLlmModelsUpdate();
        } catch (error) {
          request.log.error({ err: error }, '模型配置已保存，但通知 Worker 刷新失败');
        }
      }
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
  if (key === 'content_prompts') {
    const config = z
      .object({
        platforms: z
          .array(
            z
              .object({
                id: z
                  .string()
                  .trim()
                  .min(1)
                  .max(80)
                  .regex(/^[\w-]+$/),
                name: z.string().trim().min(1).max(40),
                prompts: z
                  .array(
                    z
                      .object({
                        id: z
                          .string()
                          .trim()
                          .min(1)
                          .max(80)
                          .regex(/^[\w-]+$/),
                        name: z.string().trim().min(1).max(24),
                        content: z.string().max(20000),
                        active: z.boolean(),
                      })
                      .strict(),
                  )
                  .max(100),
              })
              .strict(),
          )
          .max(50),
      })
      .strict()
      .parse(value) as ContentPromptsConfig;
    const platformIds = new Set<string>();
    const platformNames = new Set<string>();
    if (config.platforms.length !== PLATFORM_OPTIONS.length) {
      throw new Error('提示词平台清单与当前支持的平台不一致');
    }
    for (const platform of config.platforms) {
      const supportedPlatform = PLATFORM_OPTIONS.find((item) => item.id === platform.id);
      if (!supportedPlatform || platform.name !== supportedPlatform.name) {
        throw new Error('提示词平台必须与当前支持的平台清单一致');
      }
      const normalizedName = platform.name.toLocaleLowerCase();
      if (platformIds.has(platform.id) || platformNames.has(normalizedName)) {
        throw new Error('平台名称和标识不能重复');
      }
      platformIds.add(platform.id);
      platformNames.add(normalizedName);
      const promptIds = new Set<string>();
      const activeCount = platform.prompts.filter((prompt) => prompt.active).length;
      if (platform.prompts.length > 0 && activeCount !== 1) {
        throw new Error(`平台「${platform.name}」需要且只能有一个使用中的提示词`);
      }
      for (const prompt of platform.prompts) {
        if (promptIds.has(prompt.id)) {
          throw new Error(`平台「${platform.name}」的提示词标识不能重复`);
        }
        promptIds.add(prompt.id);
      }
    }
    return config;
  }
  if (key === 'xiaohongshu_prompt')
    return z
      .object({ systemPrompt: z.string().trim().min(50).max(20000) })
      .strict()
      .parse(value);
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
  if (key === 'llm_models') {
    return validateLlmModelsInput(value);
  }
  throw new Error(`不允许修改设置：${key}`);
}

type LlmModelsInput = Omit<LlmModelsConfig, 'providers'> & {
  providers: Array<
    Omit<LlmModelsConfig['providers'][number], 'apiKeyEncrypted'> & {
      apiKey?: string;
      hasApiKey?: boolean;
    }
  >;
};

function validateLlmModelsInput(value: unknown): LlmModelsInput {
  const selectionSchema = z
    .object({
      providerId: z.string().trim().min(1).max(80),
      modelId: z.string().trim().min(1).max(200),
    })
    .strict();
  const parsed = z
    .object({
      providers: z
        .array(
          z
            .object({
              id: z.string().trim().min(1).max(80),
              name: z.string().trim().min(1).max(100),
              baseUrl: z.url(),
              apiMode: z.enum(['chat', 'responses']),
              apiKey: z.string().max(1000).optional(),
              hasApiKey: z.boolean().optional(),
              models: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
            })
            .strict(),
        )
        .max(50),
      defaultModel: selectionSchema.nullable(),
      taskModels: z.record(z.string(), selectionSchema.nullable()).default({}),
    })
    .strict()
    .parse(value) as LlmModelsInput;

  const providerIds = new Set<string>();
  for (const provider of parsed.providers) {
    if (providerIds.has(provider.id)) throw new Error('Provider 标识不能重复');
    providerIds.add(provider.id);
    if (new Set(provider.models).size !== provider.models.length) {
      throw new Error(`Provider「${provider.name}」中模型 ID 不能重复`);
    }
  }

  const checkSelection = (selection: LlmModelsConfig['defaultModel']) => {
    if (selection === null) return;
    const provider = parsed.providers.find((item) => item.id === selection.providerId);
    if (!provider || !provider.models.includes(selection.modelId)) {
      throw new Error('默认模型或阶段模型必须选择已配置的 Provider 和模型');
    }
  };
  if (parsed.providers.length > 0 && parsed.defaultModel === null) {
    throw new Error('已配置 Provider 时必须设置默认模型');
  }
  checkSelection(parsed.defaultModel);

  const taskIds = new Set(LLM_TASKS.map((task) => task.id));
  for (const [taskId, selection] of Object.entries(parsed.taskModels)) {
    if (!taskIds.has(taskId as (typeof LLM_TASKS)[number]['id'])) {
      throw new Error(`未知的模型调用阶段：${taskId}`);
    }
    checkSelection(selection);
  }
  return parsed;
}

async function persistLlmModels(
  input: LlmModelsInput,
  existing: LlmModelsConfig | undefined,
  databasePath: string,
): Promise<LlmModelsConfig> {
  const providers: LlmModelsConfig['providers'] = [];
  for (const provider of input.providers) {
    const previous = existing?.providers.find((item) => item.id === provider.id);
    const apiKey = provider.apiKey?.trim() ?? '';
    const apiKeyEncrypted =
      apiKey !== ''
        ? await encryptLocalSecret(apiKey, databasePath)
        : previous?.apiKeyEncrypted;
    if (!apiKeyEncrypted) {
      throw new Error(`Provider「${provider.name}」需要配置 API Key`);
    }
    const { apiKey: _apiKey, hasApiKey: _hasApiKey, ...fields } = provider;
    providers.push({ ...fields, ...(apiKeyEncrypted ? { apiKeyEncrypted } : {}) });
  }
  return {
    providers,
    defaultModel: input.defaultModel,
    taskModels: input.taskModels,
  };
}
