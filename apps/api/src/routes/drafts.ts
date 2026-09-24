/**
 * 草稿路由（任务 5.5-5.7）：
 * 列表、详情、清洗 + 乐观锁 PATCH、生效内容预览、事务性幂等批准。
 *
 * 草稿以运行 id 标识（一运行一草稿，修订号递增）。
 */
import {
  appendAuditEvent,
  approveContentDraft,
  getActivePlatformPolicy,
  getLatestDraftRevision,
  getRunWithJob,
  listDrafts,
  loadRunClaimSupport,
  NotFoundError,
  softDeleteDraftRevisions,
} from '@tutor-flow/db';
import type { DbClient } from '@tutor-flow/db';
import type { ApiEnv } from '@tutor-flow/config/server';
import type { DraftMedia } from '@tutor-flow/domain';
import { hasBlockingIssues, validateXhsContent } from '@tutor-flow/workflow';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { isOperator, requireAuthenticated } from '../lib/auth.js';
import { parseBody } from '../lib/http.js';
import { sanitizeRichText, sanitizeTags, sanitizeTitle } from '../lib/sanitize.js';

export interface DraftRoutesOptions {
  db: DbClient;
  env: ApiEnv;
}

/** 读取运行最新草稿修订；不存在抛 NotFoundError */
async function requireLatestDraft(db: DbClient, runId: string) {
  const draft = await getLatestDraftRevision(db.db, runId);
  if (draft === null) {
    throw new NotFoundError(`草稿不存在：run=${runId}`);
  }
  return draft;
}

/** 组装草稿的生效校验结果（预览与批准共用） */
async function buildValidation(db: DbClient, runId: string) {
  const draft = await requireLatestDraft(db, runId);
  const policy = await getActivePlatformPolicy(db.db);
  const claimSupport = await loadRunClaimSupport(db.db, runId);

  const issues = validateXhsContent(
    {
      title: draft.title,
      body: draft.body,
      tags: draft.tags as string[],
      mediaObjectKeys: draft.mediaObjectKeys as DraftMedia[],
      aigcDisclosure: draft.aigcDisclosure,
      claimUsages: draft.claimUsages as Array<{ claimId: string }>,
    },
    policy.policy,
    claimSupport.map((claim) => ({ claimId: claim.claimId, hasSource: claim.hasSource })),
  );
  return { draft, policy, issues };
}

export function registerDraftRoutes(
  app: FastifyInstance,
  options: DraftRoutesOptions,
): void {
  const { db, env } = options;
  const authenticate = requireAuthenticated(env, db);

  // 草稿列表（默认待审核）
  app.get('/api/v1/drafts', { preHandler: authenticate }, async (request, reply) => {
    if (!isOperator(request.actor)) {
      return reply.code(403).send({ error: '仅运营人员可查看草稿' });
    }
    const query = request.query as { status?: string };
    const status =
      query['status'] === 'APPROVED' ||
      query['status'] === 'REJECTED' ||
      query['status'] === 'SUPERSEDED'
        ? query['status']
        : 'PENDING_REVIEW';
    const result = await listDrafts(db.db, { status, limit: 50, offset: 0 });
    return reply.send({
      items: result.items.map(({ draft, job }) => ({
        runId: draft.runId,
        revision: draft.revision,
        status: draft.status,
        title: draft.title,
        topic: job.topic,
        updatedAt: draft.updatedAt,
      })),
      total: result.total,
    });
  });

  // 草稿详情（最新修订）
  app.get(
    '/api/v1/drafts/:runId',
    { preHandler: authenticate },
    async (request, reply) => {
      if (!isOperator(request.actor)) {
        return reply.code(403).send({ error: '仅运营人员可查看草稿详情' });
      }
      const { runId } = request.params as { runId: string };
      const draft = await requireLatestDraft(db, runId);
      const loaded = await getRunWithJob(db.db, runId);
      return reply.send({
        runId: draft.runId,
        revision: draft.revision,
        status: draft.status,
        title: draft.title,
        body: draft.body,
        tags: draft.tags,
        mediaObjectKeys: draft.mediaObjectKeys,
        claimUsages: draft.claimUsages,
        aigcDisclosure: draft.aigcDisclosure,
        topic: loaded?.job.topic ?? '',
        updatedAt: draft.updatedAt,
      });
    },
  );

  app.delete(
    '/api/v1/drafts/:runId',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = request.actor;
      if (actor === undefined || actor.kind !== 'operator') {
        return reply.code(403).send({ error: '仅运营人员可删除草稿' });
      }
      const { runId } = request.params as { runId: string };
      const deleted = await softDeleteDraftRevisions(db.db, runId);
      await appendAuditEvent(db.db, {
        actorType: 'operator',
        actorId: actor.id,
        action: 'draft.deleted',
        resourceType: 'draft_revision',
        resourceId: runId,
        runId,
        payload: { revision: deleted.revision, status: deleted.status },
      });
      return reply.send({ runId, deleted: true });
    },
  );

  // 保存草稿（自动保存与手工保存共用；服务端清洗 + 乐观锁）
  app.patch(
    '/api/v1/drafts/:runId',
    { preHandler: authenticate },
    async (request, reply) => {
      if (!isOperator(request.actor)) {
        return reply.code(403).send({ error: '仅运营人员可查看草稿预览' });
      }
      const actor = request.actor;
      if (actor === undefined || actor.kind !== 'operator') {
        return reply.code(403).send({ error: '仅运营人员可编辑草稿' });
      }
      const { runId } = request.params as { runId: string };
      const body = parseBody(
        z
          .object({
            expectedRevision: z.coerce.number().int().positive(),
            title: z.string().max(500).optional(),
            body: z.string().max(20_000).optional(),
            tags: z.array(z.string().max(50)).max(30).optional(),
            mediaObjectKeys: z
              .array(
                z.union([
                  z.string().max(300),
                  z
                    .object({
                      fileId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
                      name: z.string().min(1).max(200),
                      contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
                    })
                    .strict(),
                ]),
              )
              .max(30)
              .optional(),
            aigcDisclosure: z.enum(['disclosed', 'undisclosed']).optional(),
          })
          .strict(),
        request.body,
      );

      // 服务端清洗（信任边界）
      const patch: {
        title?: string;
        body?: string;
        tags?: string[];
        mediaObjectKeys?: DraftMedia[];
        aigcDisclosure?: string;
      } = {};
      if (body.title !== undefined) {
        patch.title = sanitizeTitle(body.title);
      }
      if (body.body !== undefined) {
        patch.body = sanitizeRichText(body.body);
      }
      if (body.tags !== undefined) {
        patch.tags = sanitizeTags(body.tags);
      }
      if (body.mediaObjectKeys !== undefined) {
        patch.mediaObjectKeys = body.mediaObjectKeys;
      }
      if (body.aigcDisclosure !== undefined) {
        patch.aigcDisclosure = body.aigcDisclosure;
      }

      const revision = await saveDraftRevisionSafe(db, {
        runId,
        expectedRevision: body.expectedRevision,
        savedBy: actor.id,
        patch,
      });

      await appendAuditEvent(db.db, {
        actorType: 'operator',
        actorId: actor.id,
        action: 'draft.edited',
        resourceType: 'draft_revision',
        resourceId: revision.id,
        runId,
        payload: { revision: revision.revision },
      });

      return reply.send({
        runId,
        revision: revision.revision,
        savedAt: revision.createdAt,
        title: revision.title,
      });
    },
  );

  // 生效内容预览（5.6）
  app.get(
    '/api/v1/drafts/:runId/preview',
    { preHandler: authenticate },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const { draft, policy, issues } = await buildValidation(db, runId);
      return reply.send({
        runId,
        revision: draft.revision,
        policyVersion: policy.version,
        title: draft.title,
        titleLength: [...draft.title].length,
        bodyLength: [...draft.body].length,
        tags: draft.tags,
        mediaObjectKeys: draft.mediaObjectKeys,
        aigcDisclosure: draft.aigcDisclosure,
        issues,
        blocking: hasBlockingIssues(issues),
      });
    },
  );

  // 批准草稿（5.7）：重新校验最新修订 → 事务性创建发布任务（幂等）
  app.post(
    '/api/v1/drafts/:runId/approve',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = request.actor;
      if (actor === undefined || actor.kind !== 'operator') {
        return reply.code(403).send({ error: '仅运营人员可批准草稿' });
      }
      const { runId } = request.params as { runId: string };
      const body = parseBody(
        z
          .object({
            expectedRevision: z.coerce.number().int().positive(),
          })
          .strict(),
        request.body,
      );

      // 1. 重校验最新修订（批准动作不信任旧校验结果）
      const { issues } = await buildValidation(db, runId);
      if (hasBlockingIssues(issues)) {
        return reply.code(422).send({
          error: '草稿未通过批准检查',
          issues,
        });
      }

      // 2. 事务性批准（幂等；最多一个发布任务）
      const loaded = await getRunWithJob(db.db, runId);
      if (loaded === null) {
        throw new NotFoundError(`运行任务不存在：${runId}`);
      }
      const draft = await approveContentDraft(db.db, {
        runId,
        expectedRevision: body.expectedRevision,
        approvedBy: actor.id,
      });

      await appendAuditEvent(db.db, {
        actorType: 'operator',
        actorId: actor.id,
        action: 'draft.approved',
        resourceType: 'draft_revision',
        resourceId: draft.id,
        runId,
        payload: {
          revision: draft.revision,
          policyVersion: (await getActivePlatformPolicy(db.db)).version,
        },
      });

      return reply.send({
        runId,
        revision: draft.revision,
        status: draft.status,
      });
    },
  );
}

/** 保存草稿（清洗后写新修订） */
async function saveDraftRevisionSafe(
  db: DbClient,
  input: {
    runId: string;
    expectedRevision: number;
    savedBy: string;
    patch: {
      title?: string;
      body?: string;
      tags?: string[];
      mediaObjectKeys?: DraftMedia[];
      aigcDisclosure?: string;
    };
  },
) {
  const { saveDraftRevision } = await import('@tutor-flow/db');
  return saveDraftRevision(db.db, {
    runId: input.runId,
    expectedRevision: input.expectedRevision,
    title: input.patch.title,
    body: input.patch.body,
    tags: input.patch.tags,
    mediaObjectKeys: input.patch.mediaObjectKeys,
    aigcDisclosure: input.patch.aigcDisclosure,
    savedBy: input.savedBy,
  });
}
