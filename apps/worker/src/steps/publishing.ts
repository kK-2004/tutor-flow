/**
 * 发布步骤处理器（任务 6.5-6.9）：
 * PUBLISH（effectively-once 发布）与 VERIFY_PUBLICATION（状态核验）。
 *
 * 安全规则：
 * - 回执优先：已有回执只核验，绝不重复调用发布；
 * - 发布前用最新生效策略重新校验（策略漂移防护）；
 * - 结果未知（超时/响应丢失）→ UNKNOWN_OUTCOME + 转人工，禁止盲发；
 * - 账号级串行 + 令牌桶 + 抖动 + 熔断（通过账号通道执行）。
 */
import { createHash } from 'node:crypto';

import {
  appendAuditEvent,
  claimPublishJob,
  findAccount,
  findReceiptByJob,
  getActivePlatformPolicy,
  getLatestDraftRevision,
  getRunPublishJob,
  getRunWithJob,
  loadRunClaimSupport,
  requireRun,
  updateAccountHealth,
  updatePublishJobStatus,
  updateReceiptVerification,
  upsertPublishReceipt,
  type DbClient,
} from '@tutor-flow/db';
import { hasBlockingIssues, validateXhsContent } from '@tutor-flow/workflow';
import type { DraftMedia } from '@tutor-flow/domain';
import type { StepHandler } from '@tutor-flow/workflow';
import {
  PublisherError,
  type PublisherAccountRef,
  type PublisherAdapter,
} from '@tutor-flow/integrations';

import type { PublishLane } from '../publisher/lanes.js';
import type { SecretProvider } from '@tutor-flow/config/server';

export interface PublishingHandlersDeps {
  db: DbClient;
  adapter: PublisherAdapter;
  /** 账号级串行/限流/熔断通道 */
  lanes: PublishLane;
  /** 密钥提供器：按账号 secret_ref 短时解析 Cookie */
  secrets: SecretProvider;
  /** 发布前抖动上限（毫秒；测试可置 0） */
  jitterMs?: number;
}

/** 解析账号引用（密钥短时挂载） */
async function resolveAccountRef(
  db: DbClient,
  secrets: SecretProvider,
  accountId: string,
  adapter: PublisherAdapter,
): Promise<PublisherAccountRef> {
  const account = await findAccount(db.db, accountId);
  if (account === null) {
    throw new PublisherError('REJECTED', `平台账号不存在：${accountId}`);
  }
  const secretValue =
    adapter.sessionMode === 'sidecar'
      ? ''
      : await secrets.resolveSecret(account.secretRef);
  return { accountId: account.id, alias: account.alias, secretValue };
}

/** 发布失败分类 */
type ClassifiedPublisher = {
  category:
    | 'TRANSIENT'
    | 'AUTH_EXPIRED'
    | 'CHALLENGE_REQUIRED'
    | 'SELECTOR'
    | 'UNKNOWN_OUTCOME'
    | 'NEEDS_HUMAN'
    | 'REJECTED';
  sideEffectSuspected: boolean;
  message: string;
};

function classifyPublisherError(error: unknown): ClassifiedPublisher {
  if (error instanceof PublisherError) {
    return {
      category: error.code,
      sideEffectSuspected: error.sideEffectSuspected,
      message: error.message,
    };
  }
  return {
    category: 'REJECTED',
    sideEffectSuspected: false,
    message: error instanceof Error ? error.message.slice(0, 200) : '未知发布错误',
  };
}

/** 加载发布载荷：最新草稿修订 + 运行事实支持 */
async function loadPublishContent(db: DbClient, runId: string) {
  const draft = await getLatestDraftRevision(db.db, runId);
  if (draft === null) {
    throw new PublisherError('REJECTED', `缺少草稿：run=${runId}`);
  }
  const claimSupport = await loadRunClaimSupport(db.db, runId);
  return {
    title: draft.title,
    body: draft.body,
    tags: draft.tags as string[],
    mediaObjectKeys: draft.mediaObjectKeys as DraftMedia[],
    aigcDisclosed: draft.aigcDisclosure === 'disclosed',
    revision: draft.revision,
    claimSupport,
  };
}

/** 创建 PUBLISH 步骤处理器 */
export function createPublishHandler(deps: PublishingHandlersDeps): StepHandler {
  return async (context) => {
    const { run } = context;

    // 1. 定位发布任务（批准阶段创建）
    const job = await getRunPublishJob(deps.db.db, run.id);
    if (job === null) {
      throw new PublisherError('REJECTED', `运行缺少待发布的发布任务：run=${run.id}`);
    }

    // 2. 回执优先短路：已有回执只核验，绝不重复调用发布
    const existingReceipt = await findReceiptByJob(deps.db.db, job.id);
    if (existingReceipt !== null) {
      const accountRef = await resolveAccountRef(
        deps.db,
        deps.secrets,
        job.accountId,
        deps.adapter,
      );
      const status = await deps.adapter.queryStatus(
        accountRef,
        existingReceipt.platformPostId,
      );
      if (status.exists) {
        await updateReceiptVerification(
          deps.db.db,
          job.id,
          'VERIFIED',
          status.url,
          status.note,
        );
        await updatePublishJobStatus(deps.db.db, job.id, 'SUCCEEDED');
        return { outputRef: job.draftRevisionId };
      }
      await updateReceiptVerification(
        deps.db.db,
        job.id,
        'MISSING',
        undefined,
        status.note ?? '平台侧未找到已存在回执',
      );
      await updatePublishJobStatus(deps.db.db, job.id, 'NEEDS_HUMAN', {
        lastError: { category: 'UNKNOWN_OUTCOME', message: '已存在回执但平台侧核验失败' },
      });
      throw new PublisherError('UNKNOWN_OUTCOME', '已存在回执但平台侧核验失败', true);
    }

    // 另一个消费者已经原子认领时直接确认投递，不触发第二次外部调用。
    if (job.status === 'PUBLISHING') {
      return { outputRef: job.draftRevisionId };
    }
    if (job.status === 'SUCCEEDED') {
      return { outputRef: job.draftRevisionId };
    }
    if (job.status === 'UNKNOWN_OUTCOME' || job.status === 'NEEDS_HUMAN') {
      const lastError =
        typeof job.lastError === 'object' && job.lastError !== null
          ? (job.lastError as { message?: unknown }).message
          : undefined;
      throw new PublisherError(
        'UNKNOWN_OUTCOME',
        typeof lastError === 'string' ? lastError : '发布任务已转人工处理，禁止重复投递',
        true,
      );
    }
    if (job.status === 'CANCELLED') {
      throw new PublisherError('REJECTED', '发布任务已取消，禁止重复投递');
    }

    // 3. 载荷与策略漂移重校验（批准后策略可能已更新）
    const content = await loadPublishContent(deps.db, run.id);
    const runWithJob = await getRunWithJob(deps.db.db, run.id);
    const policy = await getActivePlatformPolicy(deps.db.db);
    const issues = validateXhsContent(
      {
        title: content.title,
        body: content.body,
        tags: content.tags,
        mediaObjectKeys: content.mediaObjectKeys,
        aigcDisclosure: content.aigcDisclosed ? 'disclosed' : 'undisclosed',
        claimUsages: content.claimSupport.map((claim) => ({ claimId: claim.claimId })),
        contentType: 'image_text',
        publishMode: runWithJob?.job.publishMode ?? 'review',
      },
      policy.policy,
      content.claimSupport.map((claim) => ({
        claimId: claim.claimId,
        hasSource: claim.hasSource,
      })),
    );
    if (hasBlockingIssues(issues)) {
      await updatePublishJobStatus(deps.db.db, job.id, 'NEEDS_HUMAN', {
        lastError: {
          category: 'POLICY',
          message: '发布前策略重校验未通过（策略可能已更新）',
        },
      });
      throw new PublisherError(
        'REJECTED',
        `策略漂移：${issues.map((issue) => issue.message).join('；')}`,
      );
    }

    // 4. 适配器能力校验
    const accountRef = await resolveAccountRef(
      deps.db,
      deps.secrets,
      job.accountId,
      deps.adapter,
    );
    const adapterCheck = await deps.adapter.validate(accountRef, {
      title: content.title,
      body: content.body,
      tags: content.tags,
      mediaObjectKeys: content.mediaObjectKeys,
      aigcDisclosed: content.aigcDisclosed,
    });
    if (!adapterCheck.valid) {
      await updatePublishJobStatus(deps.db.db, job.id, 'NEEDS_HUMAN', {
        lastError: { category: 'CONTENT', message: adapterCheck.issues.join('；') },
      });
      throw new PublisherError(
        'REJECTED',
        `适配器校验未通过：${adapterCheck.issues.join('；')}`,
      );
    }

    // 5. 原子认领发布任务，防止重复队列投递并发进入外部副作用。
    const claimed = await claimPublishJob(deps.db.db, job.id);
    if (claimed === null) {
      return { outputRef: job.draftRevisionId };
    }
    await appendAuditEvent(deps.db.db, {
      actorType: 'worker',
      actorId: 'publisher-worker',
      action: 'publish.attempted',
      resourceType: 'publish_job',
      resourceId: job.id,
      runId: run.id,
      publishJobId: job.id,
      payload: { attempt: claimed.attempts, accountId: job.accountId },
      traceId: run.traceId ?? undefined,
    });

    // 6. 经账号通道执行发布（串行 + 令牌桶 + 抖动 + 熔断）
    const account = await findAccount(deps.db.db, job.accountId);
    const laneConfig = {
      concurrency: account?.concurrency ?? 1,
      tokensPerWindow: account?.tokensPerWindow ?? 4,
      windowMs: account?.windowMs ?? 3_600_000,
      jitterMs: deps.jitterMs ?? 30_000,
    };
    await deps.lanes.run(job.accountId, laneConfig, async () => {
      if (deps.lanes.isBreakerOpen(job.accountId)) {
        throw new PublisherError('SELECTOR', '账号发布熔断器打开');
      }
      let publishResult;
      try {
        publishResult = await deps.adapter.publish(accountRef, {
          title: content.title,
          body: content.body,
          tags: content.tags,
          mediaObjectKeys: content.mediaObjectKeys,
          aigcDisclosed: content.aigcDisclosed,
        });
      } catch (error) {
        const classified = classifyPublisherError(error);
        // 选择器失效：计入熔断
        if (classified.category === 'SELECTOR') {
          deps.lanes.recordSelectorFailure(job.accountId);
        }
        if (classified.category === 'NEEDS_HUMAN') {
          await updatePublishJobStatus(deps.db.db, job.id, 'NEEDS_HUMAN', {
            lastError: { category: 'NEEDS_HUMAN', message: classified.message },
          });
          throw new PublisherError('NEEDS_HUMAN', classified.message, true);
        }
        // 副作用疑似（超时/响应丢失）→ UNKNOWN_OUTCOME：先核验，禁止盲发
        if (classified.category === 'UNKNOWN_OUTCOME' || classified.sideEffectSuspected) {
          await updatePublishJobStatus(deps.db.db, job.id, 'UNKNOWN_OUTCOME', {
            lastError: { category: 'UNKNOWN_OUTCOME', message: classified.message },
          });
          await updateAccountHealthSafe(
            deps,
            job.accountId,
            'UNKNOWN',
            classified.message,
          );
          throw new PublisherError('UNKNOWN_OUTCOME', classified.message, true);
        }
        // 授权/验证 → 转人工 + 账号健康联动
        if (
          classified.category === 'AUTH_EXPIRED' ||
          classified.category === 'CHALLENGE_REQUIRED'
        ) {
          await updatePublishJobStatus(deps.db.db, job.id, 'NEEDS_HUMAN', {
            lastError: { category: classified.category, message: classified.message },
          });
          await updateAccountHealthSafe(
            deps,
            job.accountId,
            classified.category === 'AUTH_EXPIRED'
              ? 'AUTH_REQUIRED'
              : 'CHALLENGE_REQUIRED',
            classified.message,
          );
          throw error;
        }
        // 选择器失效 → 转人工
        if (classified.category === 'SELECTOR') {
          await updatePublishJobStatus(deps.db.db, job.id, 'NEEDS_HUMAN', {
            lastError: { category: 'SELECTOR', message: classified.message },
          });
          throw error;
        }
        // 平台拒绝（内容问题）→ 转人工
        if (classified.category === 'REJECTED') {
          await updatePublishJobStatus(deps.db.db, job.id, 'NEEDS_HUMAN', {
            lastError: { category: 'CONTENT', message: classified.message },
          });
          throw error;
        }
        // 其余瞬时错误：抛回引擎（有界退避重试）
        throw new PublisherError('TRANSIENT', classified.message);
      }

      // 7. 回执优先落库，再执行平台状态核验
      const requestHash = createHash('sha256')
        .update(`${content.title}|${content.revision}`)
        .digest('hex');
      const receipt = await upsertPublishReceipt(deps.db.db, {
        publishJobId: job.id,
        platformPostId: publishResult.platformPostId,
        platformUrl: publishResult.platformUrl,
        requestHash,
        sanitizedResponse: { noteId: publishResult.platformPostId },
        publishedAt: new Date(),
        policyVersion: policy.version,
      });
      if (receipt.created) {
        await appendAuditEvent(deps.db.db, {
          actorType: 'worker',
          actorId: 'publisher-worker',
          action: 'publish.receipt_saved',
          resourceType: 'publish_receipt',
          resourceId: receipt.receipt.id,
          runId: run.id,
          publishJobId: job.id,
          payload: {
            platformPostId: publishResult.platformPostId,
            verification: 'PENDING',
          },
          traceId: run.traceId ?? undefined,
        });
      }
      const verification = await deps.adapter.queryStatus(
        accountRef,
        publishResult.platformPostId,
      );
      if (verification.exists) {
        await updateReceiptVerification(
          deps.db.db,
          job.id,
          'VERIFIED',
          verification.url,
          verification.note,
        );
        await updatePublishJobStatus(deps.db.db, job.id, 'SUCCEEDED');
        await appendAuditEvent(deps.db.db, {
          actorType: 'worker',
          actorId: 'publisher-worker',
          action: 'publish.succeeded',
          resourceType: 'publish_job',
          resourceId: job.id,
          runId: run.id,
          publishJobId: job.id,
          payload: { platformUrl: verification.url },
          traceId: run.traceId ?? undefined,
        });
      } else {
        await updateReceiptVerification(
          deps.db.db,
          job.id,
          'MISSING',
          undefined,
          verification.note ?? '发布后核验未找到平台内容',
        );
        await updatePublishJobStatus(deps.db.db, job.id, 'NEEDS_HUMAN', {
          lastError: {
            category: 'UNKNOWN_OUTCOME',
            message: '发布回执核验失败，需人工处理',
          },
        });
        throw new PublisherError('UNKNOWN_OUTCOME', '发布回执核验失败，需人工处理', true);
      }
      deps.lanes.recordSuccess(job.accountId);
    });

    return { outputRef: job.draftRevisionId };
  };
}

/** 账号健康联动（失败静默：不阻断发布错误处置主流程） */
async function updateAccountHealthSafe(
  deps: PublishingHandlersDeps,
  accountId: string,
  health: 'UNKNOWN' | 'AUTH_REQUIRED' | 'CHALLENGE_REQUIRED',
  message: string,
): Promise<void> {
  try {
    await updateAccountHealth(deps.db.db, accountId, {
      health,
      note: message,
      needsHumanAttention: true,
    });
  } catch {
    // 账号状态更新失败不阻断发布处置
  }
}

// ---------- 状态核验（VERIFY_PUBLICATION，6.8） ----------

/** 创建 VERIFY_PUBLICATION 步骤处理器 */
export function createVerifyPublicationHandler(
  deps: PublishingHandlersDeps,
): StepHandler {
  return async (context) => {
    const { run } = context;
    void (await requireRun(deps.db.db, run.id));
    const job = await getRunPublishJob(deps.db.db, run.id);
    if (job === null) {
      throw new PublisherError('REJECTED', `运行缺少发布任务：run=${run.id}`);
    }
    const receipt = await findReceiptByJob(deps.db.db, job.id);
    if (receipt === null) {
      // 无回执却进入核验：状态机异常，转人工
      await updatePublishJobStatus(deps.db.db, job.id, 'NEEDS_HUMAN', {
        lastError: { category: 'UNKNOWN_OUTCOME', message: '核验阶段缺少回执' },
      });
      throw new PublisherError('UNKNOWN_OUTCOME', '核验阶段缺少回执', true);
    }

    const accountRef = await resolveAccountRef(
      deps.db,
      deps.secrets,
      job.accountId,
      deps.adapter,
    );
    const status = await deps.adapter.queryStatus(accountRef, receipt.platformPostId);

    if (status.exists) {
      await updateReceiptVerification(
        deps.db.db,
        job.id,
        'VERIFIED',
        status.url,
        status.note,
      );
      return { outputRef: receipt.platformPostId };
    }
    // 平台侧不存在：不盲目重发，转人工
    await updateReceiptVerification(
      deps.db.db,
      job.id,
      'MISSING',
      undefined,
      status.note ?? '平台侧未找到内容',
    );
    await updatePublishJobStatus(deps.db.db, job.id, 'NEEDS_HUMAN', {
      lastError: {
        category: 'UNKNOWN_OUTCOME',
        message: '核验发现平台侧内容缺失，需人工处置',
      },
    });
    throw new PublisherError('UNKNOWN_OUTCOME', '平台侧内容缺失', true);
  };
}
