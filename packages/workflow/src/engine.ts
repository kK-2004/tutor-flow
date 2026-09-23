/**
 * 持久化工作流引擎。
 *
 * 职责：
 * - 检查点推进：步骤成功后按模式规划下一步并原子地
 *   （转换状态 + 写事件 + 入发件箱）推进；
 * - 终态规则：VERIFY_PUBLICATION 完成即 SUCCEEDED；人工停点不再派发；
 * - 失败处置：可重试分类且有剩余次数 → RETRY_WAIT + 退避重投；
 *   否则 NEEDS_HUMAN；
 * - 恢复扫描：重启后重新入队未完成运行的当前检查点
 *   （步骤幂等由处理器中间件保证）；
 * - 取消与人工选向恢复。
 */
import {
  DEFAULT_QUALITY_THRESHOLDS,
  isRetryableErrorCategory,
  meetsDirectionThresholds,
  type DirectionScoreFactors,
  type ErrorCategory,
  type StepType,
  type WorkflowRunStatus,
} from '@tutor-flow/domain';
import {
  appendAuditEvent,
  appendWorkflowEvent,
  enqueueOutbox,
  getRunWithJob,
  listClaimSourceIds,
  listDirectionClaimIds,
  listDirectionOptions,
  listResumableRuns,
  NotFoundError,
  OptimisticLockError,
  requestRunCancel,
  requireRun,
  StateGuardError,
  setRunSelectedDirection,
  stepRuns,
  transitionRunStatus,
  type DbClient,
} from '@tutor-flow/db';
import { and, desc, eq } from 'drizzle-orm';

import { StepFailure } from './step-processor.js';
import type { StepHandler } from './step-processor.js';
import type { StepJobData } from './job-data.js';

/** 自动重试上限（有界重试） */
export const MAX_AUTO_RETRIES = 3;

/** 人工处理类错误所需的解决操作说明（拒绝重试时返回给运营人员） */
export const HUMAN_ACTION_GUIDANCE: Record<string, string> = {
  AUTH_EXPIRED: '请先在小红书完成重新登录，并在系统设置中检查账号授权状态',
  CHALLENGE_REQUIRED: '请在平台完成扫码/验证码/短信验证后，确认账号恢复健康',
  VALIDATION: '请修正输入或内容后重试',
  POLICY: '请按最新平台策略调整内容后再批准发布',
  CONTENT: '请编辑内容解决合规问题后重新提交审核',
  SELECTOR: '页面结构已变化，请通知管理员运行适配器契约校验并修复选择器',
  UNKNOWN_OUTCOME: '发布结果未知，必须先执行平台侧状态核验，核验前禁止重试',
  INTERNAL: '内部错误，请查看系统日志或联系管理员',
} as const;

/** 步骤所属阶段：规划检查点推进时使用 */
const STEP_PHASE: Partial<Record<StepType, WorkflowRunStatus>> = {
  QUERY_PLANNING: 'RESEARCHING',
  SEARCH: 'RESEARCHING',
  FETCH_SOURCES: 'RESEARCHING',
  DEDUPE_SOURCES: 'RESEARCHING',
  SCORE_SOURCES: 'RESEARCHING',
  EXTRACT_CLAIMS: 'RESEARCHING',
  GENERATE_DIRECTIONS: 'RESEARCHING',
  SELECT_DIRECTION: 'GENERATING',
  GENERATE_CANONICAL: 'GENERATING',
  ADAPT_XIAOHONGSHU: 'GENERATING',
  MODERATE_CONTENT: 'MODERATING',
  CREATE_DRAFT: 'MODERATING',
  VALIDATE_PUBLISH: 'PUBLISHING',
  PUBLISH: 'PUBLISHING',
  VERIFY_PUBLICATION: 'PUBLISHING',
};

/** 研究与生成链路的线性推进表 */
const NEXT_STEP: Partial<Record<StepType, StepType>> = {
  QUERY_PLANNING: 'SEARCH',
  SEARCH: 'FETCH_SOURCES',
  FETCH_SOURCES: 'DEDUPE_SOURCES',
  DEDUPE_SOURCES: 'SCORE_SOURCES',
  SCORE_SOURCES: 'EXTRACT_CLAIMS',
  EXTRACT_CLAIMS: 'GENERATE_DIRECTIONS',
  SELECT_DIRECTION: 'GENERATE_CANONICAL',
  GENERATE_CANONICAL: 'ADAPT_XIAOHONGSHU',
  ADAPT_XIAOHONGSHU: 'MODERATE_CONTENT',
  VALIDATE_PUBLISH: 'PUBLISH',
  PUBLISH: 'VERIFY_PUBLICATION',
};

/** 步骤完成后的推进计划 */
export interface StepPlan {
  /** 需要迁移到的运行状态（保持当前状态时省略） */
  status?: WorkflowRunStatus;
  /** 下一个要执行的步骤 */
  nextStep?: StepType;
  /** 进入人工停点（不再派发） */
  stop?: 'WAITING_DIRECTION' | 'NEEDS_REVIEW';
  /** 进入成功终态 */
  terminal?: true;
}

/**
 * 纯函数：规划下一步。
 * SELECT_DIRECTION 失败（无合格方向）走失败处置路径，不在此处理。
 */
export function planNextStep(input: {
  completedStep: StepType;
  directionMode: 'auto' | 'manual';
  publishMode: 'review' | 'auto';
  /** 发布安全开关：为 true 时 auto 模式也必须经草稿箱人工批准 */
  requireHumanApproval: boolean;
}): StepPlan {
  const { completedStep, directionMode, publishMode, requireHumanApproval } = input;
  const reviewMode = publishMode === 'review' || requireHumanApproval;

  // 审核通过后先创建草稿（审核模式），随后进入草稿箱停点
  if (completedStep === 'MODERATE_CONTENT') {
    return { nextStep: 'CREATE_DRAFT' };
  }
  if (completedStep === 'CREATE_DRAFT') {
    if (reviewMode) {
      return { status: 'NEEDS_REVIEW', stop: 'NEEDS_REVIEW' };
    }
    // 自动模式：先过发布前校验（校验处理器不通过会转入人工）
    return { nextStep: 'VALIDATE_PUBLISH' };
  }

  // 方向决策：人工模式停点等待；自动模式执行引擎内置选向步骤
  if (completedStep === 'GENERATE_DIRECTIONS') {
    if (directionMode === 'manual') {
      return { status: 'WAITING_DIRECTION', stop: 'WAITING_DIRECTION' };
    }
    return { nextStep: 'SELECT_DIRECTION' };
  }

  // 成功终态
  if (completedStep === 'VERIFY_PUBLICATION') {
    return { status: 'SUCCEEDED', terminal: true };
  }

  // 阶段切换 + 线性推进
  const next = NEXT_STEP[completedStep];
  if (next === undefined) {
    return {};
  }
  const phase = STEP_PHASE[next];
  return { status: phase, nextStep: next };
}

/** 退避延迟：指数增长 + 有界 */
export function computeRetryBackoffMs(attemptNo: number): number {
  const base = Math.min(2000 * 2 ** (attemptNo - 1), 60_000);
  const jitter = Math.floor(Math.random() * 500);
  return base + jitter;
}

/** 失败处置入参 */
export interface StepFailureInfo {
  stepType: StepType;
  stepRunId: string;
  attemptNo: number;
  category: ErrorCategory;
  message: string;
}

/** 自动选向使用的门槛快照（来自系统设置，缺省回退默认值） */
interface DirectionThresholds {
  minSourceCoverage: number;
  minPrimarySources: number;
  minDirectionScore: number;
  maxRisk: number;
  minSourceTotalScore: number;
}

async function loadThresholds(db: DbClient): Promise<DirectionThresholds> {
  const { getSetting } = await import('@tutor-flow/db');
  const setting = await getSetting(db.db, 'quality_thresholds');
  if (setting === null) {
    return DEFAULT_QUALITY_THRESHOLDS;
  }
  return setting.value as DirectionThresholds;
}

/** 引擎操作集合 */
export interface WorkflowEngine {
  /** 步骤成功后的检查点推进（供处理器钩子调用） */
  advanceAfterStep(runId: string, completedStep: StepType): Promise<void>;
  /** 步骤失败后的分类处置（重试或转人工） */
  handleStepFailure(runId: string, failure: StepFailureInfo): Promise<void>;
  /** 请求取消：未在执行中的状态立即终态，执行中的留给检查点 */
  cancelRun(runId: string, requestedBy: string, reason?: string): Promise<void>;
  /** 人工选向后恢复（API 方向选择接口复用） */
  resumeWithDirection(
    runId: string,
    directionId: string,
    decidedBy: string,
  ): Promise<void>;
  /** 重启恢复扫描：重新入队未完成运行的当前检查点 */
  recoverInterruptedRuns(): Promise<number>;
  /**
   * 手动重试最近一个失败步骤。
   * 仅允许可重试分类；人工处理类错误一律拒绝并说明所需操作。
   */
  retryStep(
    runId: string,
    requestedBy: string,
    reason?: string,
  ): Promise<{ stepType: StepType; attemptNo: number }>;
  /** 引擎内置处理器：自动选向等决策步骤 */
  builtInHandlers: {
    SELECT_DIRECTION: StepHandler;
  };
}

export function createWorkflowEngine(db: DbClient): WorkflowEngine {
  /** 原子推进：转换状态 + 事件 + 下一步入箱 */
  async function advance(
    runId: string,
    plan: StepPlan,
    options: {
      event: string;
      payload: Record<string, unknown>;
      nextJob?: StepJobData;
      delayMs?: number;
    },
  ): Promise<void> {
    await db.db.transaction(async (tx) => {
      const loaded = await getRunWithJob(tx, runId);
      if (loaded === null) {
        throw new NotFoundError(`运行任务不存在：${runId}`);
      }
      const { run } = loaded;
      if (plan.status !== undefined && plan.status !== run.status) {
        await transitionRunStatus(tx, runId, plan.status, {
          expectedVersion: run.version,
          currentStepType: plan.nextStep ?? run.currentStepType,
          humanWaitSince: plan.stop !== undefined ? new Date() : null,
        });
      }
      await appendWorkflowEvent(tx, runId, options.event, options.payload);
      if (options.nextJob !== undefined) {
        await enqueueOutbox(tx, {
          eventName: `workflow.step.${options.nextJob.stepType}`,
          aggregateType: 'workflow_run',
          aggregateId: runId,
          payload: {
            runId,
            job: {
              queue: 'workflow',
              name: 'workflow-step',
              data: options.nextJob,
              delayMs: options.delayMs,
            },
          },
        });
      }
    });
  }

  const engine: WorkflowEngine = {
    async advanceAfterStep(runId, completedStep) {
      const loaded = await getRunWithJob(db.db, runId);
      if (loaded === null) {
        return;
      }
      const { run, job } = loaded;

      // 取消检查点：已请求取消 → 终态化并停止派发
      if (run.cancelRequested) {
        await engine.cancelRun(runId, run.cancelRequestedBy ?? 'system:checkpoint');
        return;
      }

      // 读取发布安全开关（强制人工审核默认开启）
      const { getSetting } = await import('@tutor-flow/db');
      const guardsSetting = await getSetting(db.db, 'publish_guards');
      const guards =
        (guardsSetting?.value as { requireHumanApproval?: boolean } | null) ?? {};
      const plan = planNextStep({
        completedStep,
        directionMode: job.directionMode,
        publishMode: job.publishMode,
        requireHumanApproval: guards['requireHumanApproval'] !== false,
      });

      const nextJob: StepJobData | undefined =
        plan.nextStep !== undefined
          ? { runId, stepType: plan.nextStep, attemptNo: 1 }
          : undefined;

      if (plan.terminal === true) {
        await advance(runId, plan, {
          event: 'run.status_changed',
          payload: { from: run.status, to: 'SUCCEEDED' },
        });
        await advance(runId, plan, { event: 'run.succeeded', payload: {} });
        return;
      }
      if (plan.stop === 'WAITING_DIRECTION') {
        const options = await listDirectionOptions(db.db, runId);
        await advance(runId, plan, {
          event: 'run.waiting_direction',
          payload: { directionCount: options.length },
        });
        return;
      }
      if (plan.stop === 'NEEDS_REVIEW') {
        // 草稿实际创建在任务 5.4；此处先完成状态停点
        await advance(runId, plan, {
          event: 'run.status_changed',
          payload: { from: run.status, to: plan.status },
        });
        return;
      }
      if (plan.nextStep !== undefined && nextJob !== undefined) {
        await advance(runId, plan, {
          event: 'run.status_changed',
          payload: { from: run.status, to: plan.status ?? run.status },
          nextJob,
        });
      }
    },

    async handleStepFailure(runId, failure) {
      const loaded = await getRunWithJob(db.db, runId);
      if (loaded === null) {
        return;
      }
      const { run } = loaded;
      if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.status)) {
        return;
      }

      const canRetry =
        isRetryableErrorCategory(failure.category) &&
        failure.attemptNo < MAX_AUTO_RETRIES;
      if (canRetry) {
        const nextAttemptNo = failure.attemptNo + 1;
        const delayMs = computeRetryBackoffMs(failure.attemptNo);
        await advance(
          runId,
          { status: 'RETRY_WAIT' },
          {
            event: 'run.retry_scheduled',
            payload: {
              stepRunId: failure.stepRunId,
              stepType: failure.stepType,
              attempt: nextAttemptNo,
              scheduledAt: new Date(Date.now() + delayMs).toISOString(),
              category: failure.category,
            },
            nextJob: { runId, stepType: failure.stepType, attemptNo: nextAttemptNo },
            delayMs,
          },
        );
        return;
      }

      // 不可自动重试：转人工（等待人工处置，不自行终态化）
      await advance(
        runId,
        { status: 'NEEDS_HUMAN' },
        {
          event: 'run.needs_human',
          payload: { reason: failure.message, category: failure.category },
        },
      );
      await appendAuditEvent(db.db, {
        actorType: 'worker',
        actorId: 'workflow-engine',
        action: 'run.needs_human',
        resourceType: 'workflow_run',
        resourceId: runId,
        runId,
        payload: {
          category: failure.category,
          message: failure.message,
          stepType: failure.stepType,
          attemptNo: failure.attemptNo,
        },
      });
    },

    async cancelRun(runId, requestedBy, reason) {
      await requestRunCancel(db.db, runId, requestedBy);
      const run = await requireRun(db.db, runId);
      const immediatelyCancellable: readonly WorkflowRunStatus[] = [
        'QUEUED',
        'WAITING_DIRECTION',
        'NEEDS_REVIEW',
        'NEEDS_HUMAN',
        'RETRY_WAIT',
      ];
      if (immediatelyCancellable.includes(run.status)) {
        await db.db.transaction(async (tx) => {
          await transitionRunStatus(tx, runId, 'CANCELLED', {
            expectedVersion: run.version,
          });
          await appendWorkflowEvent(tx, runId, 'run.cancelled', { requestedBy });
        });
        await appendAuditEvent(db.db, {
          actorType: requestedBy.startsWith('scheduler:') ? 'scheduler' : 'operator',
          actorId: requestedBy,
          action: 'run.cancelled',
          resourceType: 'workflow_run',
          resourceId: runId,
          runId,
          payload: { reason },
        });
      }
      // 执行中的运行：处理器在安全检查点读取 cancelRequested 并终态化
    },

    async resumeWithDirection(runId, directionId, decidedBy) {
      const run = await requireRun(db.db, runId);
      if (run.status !== 'WAITING_DIRECTION') {
        throw new OptimisticLockError(`运行当前状态为 ${run.status}，不在人工选向停点`);
      }
      await db.db.transaction(async (tx) => {
        await transitionRunStatus(tx, runId, 'GENERATING', {
          expectedVersion: run.version,
          currentStepType: 'GENERATE_CANONICAL',
          humanWaitSince: null,
        });
        await setRunSelectedDirection(tx, runId, directionId, run.version + 1);
        await appendWorkflowEvent(tx, runId, 'run.direction_selected', {
          directionId,
          mode: 'manual',
          decidedBy,
        });
        await enqueueOutbox(tx, {
          eventName: 'workflow.step.GENERATE_CANONICAL',
          aggregateType: 'workflow_run',
          aggregateId: runId,
          payload: {
            runId,
            job: {
              queue: 'workflow',
              name: 'workflow-step',
              data: { runId, stepType: 'GENERATE_CANONICAL', attemptNo: 1 },
            },
          },
        });
      });
      await appendAuditEvent(db.db, {
        actorType: 'operator',
        actorId: decidedBy,
        action: 'direction.selected',
        resourceType: 'direction_option',
        resourceId: directionId,
        runId,
      });
    },

    async retryStep(runId, requestedBy, reason) {
      const run = await requireRun(db.db, runId);

      // 找最近一个失败步骤尝试
      const failedAttempts = await db.db
        .select()
        .from(stepRuns)
        .where(and(eq(stepRuns.runId, runId), eq(stepRuns.status, 'FAILED')))
        .orderBy(desc(stepRuns.attemptNo))
        .limit(1);
      const failed = failedAttempts[0];
      if (failed === undefined) {
        throw new StateGuardError('运行没有可重试的失败步骤');
      }

      // 错误分类守卫：人工处理类错误拒绝重试并说明所需操作
      const category = failed.errorCategory;
      if (category === null || !isRetryableErrorCategory(category)) {
        const guidance = HUMAN_ACTION_GUIDANCE[category ?? 'INTERNAL'];
        throw new StateGuardError(
          `该失败需要人工处理（${category ?? 'UNKNOWN'}）：${guidance}`,
        );
      }

      const stepType = failed.stepType;
      const attemptNo = failed.attemptNo + 1;
      const targetStatus = STEP_PHASE[stepType];
      if (targetStatus === undefined) {
        throw new StateGuardError(`步骤 ${stepType} 无法恢复到所属阶段`);
      }

      await db.db.transaction(async (tx) => {
        const fresh = await requireRun(tx, runId);
        await transitionRunStatus(tx, runId, targetStatus, {
          expectedVersion: fresh.version,
          currentStepType: stepType,
          humanWaitSince: null,
        });
        await appendWorkflowEvent(tx, runId, 'run.status_changed', {
          from: run.status,
          to: targetStatus,
        });
        await enqueueOutbox(tx, {
          eventName: `workflow.retry.${stepType}`,
          aggregateType: 'workflow_run',
          aggregateId: runId,
          payload: {
            runId,
            job: {
              queue: 'workflow',
              name: 'workflow-step',
              data: { runId, stepType, attemptNo },
            },
          },
        });
      });
      await appendAuditEvent(db.db, {
        actorType: requestedBy.startsWith('scheduler:') ? 'scheduler' : 'operator',
        actorId: requestedBy,
        action: 'step.retried',
        resourceType: 'step_run',
        resourceId: failed.id,
        runId,
        payload: { stepType, attemptNo, previousCategory: category, reason },
      });
      return { stepType, attemptNo };
    },

    async recoverInterruptedRuns() {
      const runs = await listResumableRuns(db.db);
      let recovered = 0;
      for (const run of runs) {
        const ok = await recoverOne(db, engine, run.id, run.status, run.currentStepType);
        if (ok) {
          recovered += 1;
        }
      }
      return recovered;
    },

    builtInHandlers: {
      // 自动选向：读取候选方向与门槛，选择总分最高的合格方向；
      // 无合格方向时以校验失败转入人工（不虚构通过）
      SELECT_DIRECTION: async (context) => {
        const { run } = context;

        const options = await listDirectionOptions(db.db, run.id);
        if (options.length === 0) {
          throw new StepFailure('VALIDATION', '没有候选方向，无法自动选向');
        }
        const thresholds = await loadThresholds(db);

        let best: (typeof options)[number] | undefined;
        for (const option of options) {
          const claimIds = await listDirectionClaimIds(db.db, option.id);
          const sourceMap = await listClaimSourceIds(db.db, claimIds);
          const coverage = computeCoverage(claimIds, sourceMap);
          const factors = option.scoreFactors as DirectionScoreFactors | null;
          const passes =
            factors !== null &&
            meetsDirectionThresholds(
              { scores: factors, totalScore: option.totalScore, claimIds },
              {
                minSourceCoverage: thresholds.minSourceCoverage,
                minDirectionScore: thresholds.minDirectionScore,
                maxRisk: thresholds.maxRisk,
              },
              claimIds.map((id) => ({ sourceIds: sourceMap.get(id) ?? [] })),
            ) &&
            coverage >= thresholds.minSourceCoverage;
          if (passes && (best === undefined || option.totalScore > best.totalScore)) {
            best = option;
          }
        }
        if (best === undefined) {
          throw new StepFailure('VALIDATION', '没有满足质量门槛的候选方向，转人工处理');
        }
        // 持久化选向结果（内容生成步骤读取）
        await setRunSelectedDirection(db.db, run.id, best.id, run.version);
        await appendWorkflowEvent(db.db, run.id, 'run.direction_selected', {
          directionId: best.id,
          mode: 'auto',
          decidedBy: 'engine:auto-select',
          totalScore: best.totalScore,
        });
        return { outputRef: best.id };
      },
    },
  };

  return engine;
}

/** 计算方向依赖事实的来源覆盖率 */
function computeCoverage(
  claimIds: readonly string[],
  sourceMap: Map<string, string[]>,
): number {
  if (claimIds.length === 0) {
    return 0;
  }
  const supported = claimIds.filter((id) => (sourceMap.get(id) ?? []).length > 0).length;
  return supported / claimIds.length;
}

/** 恢复单个运行：重入队当前检查点步骤（已完成步骤由中间件幂等跳过） */
async function recoverOne(
  db: DbClient,
  engine: WorkflowEngine,
  runId: string,
  status: WorkflowRunStatus,
  currentStepType: StepType | null,
): Promise<boolean> {
  const firstStep: StepType = 'QUERY_PLANNING';
  const stepType: StepType = currentStepType ?? firstStep;

  // 最新尝试：已完成 → 直接重放推进逻辑；失败 → 下一尝试；无 → 首次
  const attempts = await db.db
    .select()
    .from(stepRuns)
    .where(and(eq(stepRuns.runId, runId), eq(stepRuns.stepType, stepType)))
    .orderBy(desc(stepRuns.attemptNo))
    .limit(1);
  const latest = attempts[0];

  if (latest !== undefined && latest.status === 'SUCCEEDED') {
    // 检查点在该步骤之后：重放推进（幂等）
    await engine.advanceAfterStep(runId, stepType);
    return true;
  }

  let attemptNo = latest?.attemptNo ?? 1;
  if (latest?.status === 'FAILED') {
    // 恢复时对失败步骤再给一次机会（有界语义由 handleStepFailure 把关）
    attemptNo += 1;
  }

  await db.db.transaction(async (tx) => {
    if (status === 'QUEUED') {
      const run = await requireRun(tx, runId);
      await transitionRunStatus(tx, runId, 'RESEARCHING', {
        expectedVersion: run.version,
        currentStepType: stepType,
      });
    }
    await enqueueOutbox(tx, {
      eventName: `workflow.recover.${stepType}`,
      aggregateType: 'workflow_run',
      aggregateId: runId,
      payload: {
        runId,
        job: {
          queue: 'workflow',
          name: 'workflow-step',
          data: { runId, stepType, attemptNo },
        },
      },
    });
  });
  return true;
}
