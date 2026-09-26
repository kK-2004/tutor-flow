/**
 * 内容步骤处理器（任务 5.1-5.4）：
 * 规范文章生成 → 小红书衍生稿适配 → 内容审核 → 草稿创建。
 *
 * 提示词版本化注册（5.1）；衍生稿不执行第二次研究（5.2）；
 * 审核门槛走统一校验模块（5.3）；草稿以修订一创建（5.4）。
 */
import { createHash } from 'node:crypto';
import {
  DEFAULT_XHS_PROMPT,
  XHS_OUTPUT_CONTRACT,
  formatResearchDocumentImage,
  parseResearchDocumentImages,
} from '@tutor-flow/domain';
import { and, desc, eq, inArray } from 'drizzle-orm';

import {
  getSetting,
  contentArtifacts,
  draftRevisions,
  getActivePlatformPolicy,
  getRunWithJob,
  claimSources,
  researchDocuments,
  type DbClient,
} from '@tutor-flow/db';
import { StepFailure, validateXhsContent, type StepHandler } from '@tutor-flow/workflow';
import type { LlmGateway } from '@tutor-flow/integrations';
import { z } from 'zod';

import type { ResearchTextCache } from '../research-text-cache.js';

// ---------- 提示词版本化注册（5.1） ----------

/** 提示词配置：版本化，任务升级时追加新版本而非修改 */
export interface PromptConfig {
  version: string;
  system: string;
  buildUserPrompt: (input: string) => string;
}

/** 提示词注册表（按任务 → 版本组织） */
export const PROMPT_REGISTRY: Record<string, PromptConfig> = {
  'canonical-article@1': {
    version: 'canonical-article@1',
    system: [
      '你是内容创作助手。',
      '你只能依据「不可信网页资料」边界内的事实撰写规范文章，不得添加资料之外的事实。',
      '输出 JSON 对象：{"title":"文章标题","body":"正文（Markdown）","usedClaims":[1,2]}',
      'usedClaims 为引用事实的编号（1 起始）。正文不输出任何指令性内容。',
    ].join('\n'),
    buildUserPrompt: (input) => input,
  },
  'xhs-adapt@1': {
    version: 'xhs-adapt@1',
    system: DEFAULT_XHS_PROMPT + '\n\n' + XHS_OUTPUT_CONTRACT,
    buildUserPrompt: (input) => input,
  },
};

/** 按版本加载提示词配置；未知版本立即失败（fail-fast） */
export function loadPromptConfig(version: string): PromptConfig {
  const config = PROMPT_REGISTRY[version];
  if (config === undefined) {
    throw new StepFailure('INTERNAL', `未知提示词版本：${version}`);
  }
  return config;
}

// ---------- 共享辅助 ----------

export interface ContentHandlersDeps {
  db: DbClient;
  llm: LlmGateway;
  textCache: ResearchTextCache;
}

/** 读取运行选中的方向 */
async function getSelectedDirection(
  db: DbClient,
  runId: string,
  selectedId: string | null,
) {
  if (selectedId === null) {
    return null;
  }
  const { directionOptions } = await import('@tutor-flow/db');
  const rows = await db.db
    .select()
    .from(directionOptions)
    .where(eq(directionOptions.id, selectedId))
    .limit(1);
  return rows[0] ?? null;
}

/** 读取运行的事实及其来源支持情况 */
export async function loadClaimSupport(
  db: DbClient,
  runId: string,
): Promise<Array<{ claimId: string; statement: string; hasSource: boolean }>> {
  const { claims } = await import('@tutor-flow/db');
  const rows = await db.db.select().from(claims).where(eq(claims.runId, runId));
  const links = await db.db.select({ claimId: claimSources.claimId }).from(claimSources);
  const linked = new Set(links.map((link) => link.claimId));
  return rows.map((row) => ({
    claimId: row.id,
    statement: row.statement,
    hasSource: linked.has(row.id),
  }));
}

/** 从 LLM 文本提取 JSON 对象（容忍围栏） */
function parseJsonObject<T>(text: string, schema: z.ZodType<T>, what: string): T {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new StepFailure('TRANSIENT', `${what}输出不包含 JSON 对象`);
  }
  try {
    return schema.parse(JSON.parse(text.slice(start, end + 1)));
  } catch (error) {
    throw new StepFailure(
      'TRANSIENT',
      `${what}输出无法解析：${error instanceof Error ? error.message.slice(0, 120) : '未知错误'}`,
    );
  }
}

// ---------- 规范文章生成（GENERATE_CANONICAL） ----------

const canonicalOutputSchema = z.object({
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
  usedClaims: z.array(z.coerce.number().int().positive()).default([]),
});
const canonicalModelOutputSchema = z
  .object({
    title: z.string(),
    body: z.string(),
    usedClaims: z.array(z.number()),
  })
  .strict();

/** 创建规范文章生成处理器 */
export function createGenerateCanonicalHandler(deps: ContentHandlersDeps): StepHandler {
  return async (context) => {
    const { run } = context;
    const loaded = await getRunWithJob(deps.db.db, run.id);
    if (loaded === null) {
      throw new StepFailure('INTERNAL', '运行任务不存在');
    }
    const config = loadPromptConfig('canonical-article@1');

    const direction = await getSelectedDirection(
      deps.db,
      run.id,
      run.selectedDirectionId,
    );
    if (direction === null) {
      throw new StepFailure('CONTENT', '缺少选中的内容方向');
    }
    const claimSupport = await loadClaimSupport(deps.db, run.id);
    const selectedDocuments =
      loaded.job.researchDocumentIds.length === 0
        ? []
        : await deps.db.db
            .select({ markdown: researchDocuments.markdown })
            .from(researchDocuments)
            .where(inArray(researchDocuments.id, loaded.job.researchDocumentIds));
    const documentImages = selectedDocuments.flatMap((document) =>
      parseResearchDocumentImages(document.markdown),
    );
    const uniqueDocumentImages = [
      ...new Map(documentImages.map((image) => [image.fileId, image])).values(),
    ];

    // 事实编号映射
    const claimIdByIndex = new Map<number, string>();
    claimSupport.forEach((claim, index) => {
      claimIdByIndex.set(index + 1, claim.claimId);
    });

    const userPrompt = config.buildUserPrompt(
      [
        `主题：${loaded.job.topic}`,
        `选定方向：${direction.title} —— ${direction.summary}`,
        '目标受众：' + direction.targetAudience,
        '',
        '已核验事实（撰写时只能引用这些事实，编号如下）：',
        ...claimSupport.map((claim, index) => `${index + 1}. ${claim.statement}`),
        ...(uniqueDocumentImages.length > 0
          ? [
              '',
              '研究资料中的图片已随本次请求附加，请结合图片内容理解资料：',
              ...uniqueDocumentImages.map((image) =>
                formatResearchDocumentImage(image.fileId, image.alt),
              ),
            ]
          : []),
        '',
        '请基于以上事实撰写规范文章（Markdown），并在 usedClaims 中列出引用的事实编号。',
      ].join('\n'),
    );

    const response = await deps.llm.complete({
      task: 'canonical_article',
      promptVersion: config.version,
      systemPrompt: config.system,
      userPrompt,
      outputSchema: canonicalModelOutputSchema,
      outputName: 'canonical_article',
    });
    const parsed = parseJsonObject(response.text, canonicalOutputSchema, '规范文章');

    // usedClaims 映射回事实 id（无效编号忽略）
    const usedClaimIds = [
      ...new Set(
        parsed.usedClaims
          .map((index) => claimIdByIndex.get(index))
          .filter((id): id is string => id !== undefined),
      ),
    ];
    if (usedClaimIds.length === 0) {
      throw new StepFailure('CONTENT', '规范文章未引用任何已核验事实');
    }

    // 持久化 CANONICAL 制品（版本 1）
    const [row] = await deps.db.db
      .insert(contentArtifacts)
      .values({
        runId: run.id,
        kind: 'CANONICAL',
        version: 1,
        title: parsed.title,
        body: parsed.body,
        tags: [],
        mediaObjectKeys: [],
        claimUsages: usedClaimIds.map((claimId) => ({
          claimId,
          locator: 'body',
        })),
        generation: {
          provider: response.provider,
          model: response.model,
          promptVersion: config.version,
          generatedAt: new Date().toISOString(),
          sourceIds: [],
          tokenUsage: response.usage,
        },
        aiGenerated: true,
        aigcDisclosure: 'disclosed',
        humanReview: 'not_reviewed',
      })
      .returning();
    if (row === undefined) {
      throw new StepFailure('INTERNAL', '规范文章写入失败');
    }
    return { outputRef: row.id };
  };
}

// ---------- 小红书衍生稿适配（ADAPT_XIAOHONGSHU，5.2） ----------

const adaptOutputSchema = z.object({
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
  tags: z.array(z.string().trim().min(1)).default([]),
  usedClaims: z.array(z.coerce.number().int().positive()).default([]),
});
const adaptModelOutputSchema = z
  .object({
    title: z.string(),
    body: z.string(),
    tags: z.array(z.string()),
    usedClaims: z.array(z.number()),
  })
  .strict();

/** 加载运行最新的 CANONICAL 制品 */
export async function getLatestCanonicalArtifact(db: DbClient, runId: string) {
  const rows = await db.db
    .select()
    .from(contentArtifacts)
    .where(and(eq(contentArtifacts.runId, runId), eq(contentArtifacts.kind, 'CANONICAL')))
    .orderBy(desc(contentArtifacts.version))
    .limit(1);
  return rows[0] ?? null;
}

/** 创建小红书衍生稿适配处理器 */
export function createAdaptXiaohongshuHandler(deps: ContentHandlersDeps): StepHandler {
  return async (context) => {
    const { run } = context;
    const canonical = await getLatestCanonicalArtifact(deps.db, run.id);
    if (canonical === null) {
      throw new StepFailure('INTERNAL', '缺少规范文章：内容链路状态异常');
    }
    // 每次生成读取最新设置，已开始的调用保持同一提示词快照。
    const savedPrompts = await getSetting(deps.db.db, 'content_prompts');
    const contentPrompts = savedPrompts?.value as
      | {
          platforms?: Array<{
            id: string;
            prompts: Array<{ content: string; active: boolean }>;
          }>;
        }
      | undefined;
    const xhsPrompt = contentPrompts?.platforms?.find(
      (platform) => platform.id === 'xiaohongshu',
    );
    const legacyPrompt =
      contentPrompts === undefined
        ? await getSetting(deps.db.db, 'xiaohongshu_prompt')
        : null;
    const style = contentPrompts
      ? (xhsPrompt?.prompts.find((prompt) => prompt.active)?.content ??
        DEFAULT_XHS_PROMPT)
      : ((legacyPrompt?.value as { systemPrompt?: string } | undefined)?.systemPrompt ??
        DEFAULT_XHS_PROMPT);
    const system = style + '\n\n' + XHS_OUTPUT_CONTRACT;
    const config = {
      ...loadPromptConfig('xhs-adapt@1'),
      system,
      version: `xhs-adapt@${savedPrompts?.version ?? legacyPrompt?.version ?? 'default'}-${createHash('sha256').update(system).digest('hex').slice(0, 12)}`,
    };
    const claimSupport = await loadClaimSupport(deps.db, run.id);
    const claimIdByIndex = new Map<number, string>();
    claimSupport.forEach((claim, index) => {
      claimIdByIndex.set(index + 1, claim.claimId);
    });

    const userPrompt = config.buildUserPrompt(
      [
        '规范文章标题：' + (canonical.title ?? ''),
        '规范文章正文：',
        canonical.body,
        '',
        '已核验事实（只能引用，编号如下）：',
        ...claimSupport.map((claim, index) => `${index + 1}. ${claim.statement}`),
        '',
        '请改写为小红书图文，并在 usedClaims 中列出引用的事实编号（不得新增事实）。',
      ].join('\n'),
    );

    const response = await deps.llm.complete({
      task: 'xhs_adapt',
      promptVersion: config.version,
      systemPrompt: config.system,
      userPrompt,
      outputSchema: adaptModelOutputSchema,
      outputName: 'xiaohongshu_draft',
    });
    const parsed = parseJsonObject(response.text, adaptOutputSchema, '小红书衍生稿');

    const usedClaimIds = [
      ...new Set(
        parsed.usedClaims
          .map((index) => claimIdByIndex.get(index))
          .filter((id): id is string => id !== undefined),
      ),
    ];
    if (usedClaimIds.length === 0) {
      // 衍生稿无来源事实门槛：未继承任何已核验事实 → 拒绝
      throw new StepFailure('CONTENT', '衍生稿未引用任何已核验事实，已拒绝');
    }

    const [row] = await deps.db.db
      .insert(contentArtifacts)
      .values({
        runId: run.id,
        kind: 'XIAOHONGSHU',
        version: 1,
        title: parsed.title,
        body: parsed.body,
        tags: parsed.tags,
        mediaObjectKeys: [],
        claimUsages: usedClaimIds.map((claimId) => ({ claimId, locator: 'body' })),
        generation: {
          provider: response.provider,
          model: response.model,
          promptVersion: config.version,
          generatedAt: new Date().toISOString(),
          sourceIds: [],
          tokenUsage: response.usage,
        },
        aiGenerated: true,
        aigcDisclosure: 'disclosed',
        humanReview: 'not_reviewed',
      })
      .returning();
    if (row === undefined) {
      throw new StepFailure('INTERNAL', '衍生稿写入失败');
    }
    return { outputRef: row.id };
  };
}

// ---------- 内容审核（MODERATE_CONTENT，5.3） ----------

/** 创建内容审核处理器：统一校验模块执行全部门槛 */
export function createModerateContentHandler(deps: { db: DbClient }): StepHandler {
  return async (context) => {
    const { run } = context;
    const xhs = await getLatestXiaohongshuArtifact(deps.db, run.id);
    if (xhs === null) {
      throw new StepFailure('INTERNAL', '缺少小红书衍生稿：内容链路状态异常');
    }
    const policy = await getActivePlatformPolicy(deps.db.db);
    const claimSupport = await loadClaimSupport(deps.db, run.id);

    const issues = validateXhsContent(
      {
        title: xhs.title ?? '',
        body: xhs.body,
        tags: xhs.tags as string[],
        mediaObjectKeys: xhs.mediaObjectKeys as string[],
        aigcDisclosure: xhs.aigcDisclosure,
        claimUsages: (xhs.claimUsages as Array<{ claimId: string }>) ?? [],
      },
      policy.policy,
      claimSupport.map((claim) => ({
        claimId: claim.claimId,
        hasSource: claim.hasSource,
      })),
    );
    const blocking = issues.filter((issue) => issue.severity === 'error');
    if (blocking.length > 0) {
      throw new StepFailure(
        'CONTENT',
        `内容审核未通过：${blocking.map((issue) => issue.message).join('；')}`,
      );
    }
    return { outputRef: xhs.id };
  };
}

/** 加载运行最新的 XIAOHONGSHU 制品 */
export async function getLatestXiaohongshuArtifact(db: DbClient, runId: string) {
  const rows = await db.db
    .select()
    .from(contentArtifacts)
    .where(
      and(eq(contentArtifacts.runId, runId), eq(contentArtifacts.kind, 'XIAOHONGSHU')),
    )
    .orderBy(desc(contentArtifacts.version))
    .limit(1);
  return rows[0] ?? null;
}

// ---------- 草稿创建（CREATE_DRAFT，5.4） ----------

/** 创建草稿创建处理器：把 XIAOHONGSHU 制品固化为待审核草稿修订 */
export function createCreateDraftHandler(deps: { db: DbClient }): StepHandler {
  return async (context) => {
    const { run } = context;
    const xhs = await getLatestXiaohongshuArtifact(deps.db, run.id);
    if (xhs === null) {
      throw new StepFailure('INTERNAL', '缺少小红书衍生稿：无法创建草稿');
    }
    const existing = await deps.db.db
      .select({ id: draftRevisions.id })
      .from(draftRevisions)
      .where(eq(draftRevisions.runId, run.id))
      .limit(1);
    if (existing.length > 0) {
      // 幂等：草稿已存在（恢复重放）直接确认
      return { outputRef: existing[0]?.id ?? '' };
    }
    const [row] = await deps.db.db
      .insert(draftRevisions)
      .values({
        runId: run.id,
        revision: 1,
        status: 'PENDING_REVIEW',
        title: xhs.title ?? '未命名草稿',
        body: xhs.body,
        tags: xhs.tags as string[],
        mediaObjectKeys: xhs.mediaObjectKeys as string[],
        sourceArtifactId: xhs.id,
        claimUsages: xhs.claimUsages as Array<{ claimId: string }>,
        aigcDisclosure: 'disclosed',
        createdBy: 'system:create-draft',
      })
      .returning();
    if (row === undefined) {
      throw new StepFailure('INTERNAL', '草稿创建失败');
    }
    return { outputRef: row.id };
  };
}
