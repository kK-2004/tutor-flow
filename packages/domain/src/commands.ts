/**
 * 工作流命令类型。
 *
 * 命令表示“请求改变系统状态的动作”，由 API 层校验后落库并审计；
 * 所有命令都携带操作主体，审计事件必须明确动作来源。
 */

import type { Platform } from './platform.js';
import type { DraftMedia } from './content.js';
import type { DirectionMode, PublishMode, RunTrigger } from './run.js';

/** 创建运行任务命令（管理台与外部调度器共用） */
export interface CreateRunCommand {
  /** 内容主题（非空） */
  topic: string;
  directionMode: DirectionMode;
  publishMode: PublishMode;
  /** 目标平台：首期仅支持 xiaohongshu */
  platform: Platform;
  /** 使用的小红书平台账号 */
  accountId: string;
  trigger: RunTrigger;
  /** 幂等键：外部调度器必填；管理台可选 */
  idempotencyKey?: string;
}

/** 选择内容方向命令 */
export interface SelectDirectionCommand {
  runId: string;
  directionId: string;
  decidedBy: string;
  /** 可选的决策说明（审计用） */
  note?: string;
}

/** 取消运行命令 */
export interface CancelRunCommand {
  runId: string;
  requestedBy: string;
  reason?: string;
}

/** 重试失败步骤命令 */
export interface RetryStepCommand {
  runId: string;
  /** 不传时重试最近一个可重试的失败步骤 */
  stepRunId?: string;
  requestedBy: string;
  reason?: string;
}

/** 批准草稿命令 */
export interface ApproveDraftCommand {
  draftId: string;
  /** 预期的草稿修订版本（乐观并发校验） */
  expectedRevision: number;
  approvedBy: string;
}

/** 保存草稿命令（自动保存与手工保存共用同一接口语义） */
export interface SaveDraftCommand {
  draftId: string;
  expectedRevision: number;
  title?: string;
  body?: string;
  tags?: string[];
  mediaObjectKeys?: DraftMedia[];
  savedBy: string;
}

/** 人工解决运行任务命令（恢复/处置 NEEDS_HUMAN 状态） */
export interface ResolveHumanInterventionCommand {
  runId: string;
  /** 处置方式：恢复执行、标记失败或取消 */
  resolution: 'resume' | 'fail' | 'cancel';
  resolvedBy: string;
  note?: string;
}
