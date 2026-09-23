/**
 * 工作流事件类型。
 *
 * 事件先持久化（单调递增 event id），再通过 SSE 推送；
 * 断线客户端用 Last-Event-ID 补发。事件载荷不包含正文、Cookie 或密钥。
 */

import type { ErrorCategory } from './errors.js';
import type { StepType } from './steps.js';
import type { WorkflowRunStatus } from './run.js';

/** 事件名称全集 */
export type WorkflowEventName =
  | 'run.created'
  | 'run.status_changed'
  | 'step.started'
  | 'step.completed'
  | 'step.failed'
  | 'run.waiting_direction'
  | 'run.direction_selected'
  | 'run.needs_human'
  | 'run.retry_scheduled'
  | 'run.cancel_requested'
  | 'run.cancelled'
  | 'run.succeeded'
  | 'run.failed'
  | 'draft.created'
  | 'draft.approved'
  | 'publish.queued'
  | 'publish.attempted'
  | 'publish.receipt_saved'
  | 'publish.succeeded'
  | 'publish.failed';

/** 已持久化工作流事件的统一信封 */
export interface WorkflowEventEnvelope<
  TName extends WorkflowEventName = WorkflowEventName,
> {
  /** 全局单调递增的事件 id（SSE 的 event id） */
  id: number;
  runId: string;
  name: TName;
  /** 发生时间（ISO 8601） */
  occurredAt: string;
  payload: WorkflowEventPayloads[TName];
}

/** 各事件载荷类型映射（判别联合的基础） */
export interface WorkflowEventPayloads {
  'run.created': {
    topicLength: number;
    directionMode: string;
    publishMode: string;
    platform: string;
    triggerType: string;
    triggeredBy: string;
  };
  'run.status_changed': {
    from: WorkflowRunStatus;
    to: WorkflowRunStatus;
  };
  'step.started': {
    stepRunId: string;
    stepType: StepType;
    attempt: number;
  };
  'step.completed': {
    stepRunId: string;
    stepType: StepType;
    attempt: number;
    /** 输出引用（对象键/记录 id），不包含正文内容 */
    outputRef?: string;
    durationMs?: number;
  };
  'step.failed': {
    stepRunId: string;
    stepType: StepType;
    attempt: number;
    category: ErrorCategory;
    message: string;
  };
  'run.waiting_direction': {
    directionCount: number;
  };
  'run.direction_selected': {
    directionId: string;
    mode: 'auto' | 'manual';
    decidedBy: string;
    totalScore?: number;
  };
  'run.needs_human': {
    reason: string;
    category?: ErrorCategory;
  };
  'run.retry_scheduled': {
    stepRunId: string;
    stepType: StepType;
    attempt: number;
    /** 重试预计执行时间（ISO 8601） */
    scheduledAt: string;
    category: ErrorCategory;
  };
  'run.cancel_requested': {
    requestedBy: string;
    reason?: string;
  };
  'run.cancelled': {
    requestedBy: string;
  };
  'run.succeeded': Record<string, never>;
  'run.failed': {
    category: ErrorCategory;
    message: string;
  };
  'draft.created': {
    draftId: string;
    artifactVersion: number;
  };
  'draft.approved': {
    draftId: string;
    revision: number;
    approvedBy: string;
    publishJobId: string;
    policyVersion: string;
  };
  'publish.queued': {
    publishJobId: string;
    accountId: string;
    idempotencyKeyHash: string;
  };
  'publish.attempted': {
    publishJobId: string;
    attempt: number;
  };
  'publish.receipt_saved': {
    publishJobId: string;
    platformPostId: string;
    verification: string;
  };
  'publish.succeeded': {
    publishJobId: string;
    platformUrl?: string;
  };
  'publish.failed': {
    publishJobId: string;
    category: ErrorCategory;
    message: string;
  };
}

/** 具体类型化事件（联合） */
export type TypedWorkflowEvent = {
  [TName in WorkflowEventName]: WorkflowEventEnvelope<TName>;
}[WorkflowEventName];

/** SSE 心跳事件：不持久化，不改变工作流状态 */
export const SSE_HEARTBEAT_EVENT = ': heartbeat' as const;

/** 心跳间隔（毫秒）：穿透代理的空闲超时 */
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
