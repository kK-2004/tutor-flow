/**
 * 候选内容方向领域类型。
 *
 * 方向对象保存标题、摘要、受众、关键词、各维度分数与总分；
 * 自动模式只选择同时通过全部质量门槛的最高分方向。
 */

import type { Claim } from './research.js';

/** 方向评分因子 */
export interface DirectionScoreFactors {
  /** 来源覆盖率：方向所需事实被来源支持的比例 */
  sourceCoverage: number;
  /** 受众匹配度 */
  audienceMatch: number;
  /** 平台匹配度（小红书图文形态适配度） */
  platformMatch: number;
  /** 新颖度 */
  novelty: number;
  /** 时效性 */
  timeliness: number;
  /** 合规风险（0 最安全，1 最高风险） */
  risk: number;
}

/** 候选内容方向 */
export interface DirectionOption {
  id: string;
  runId: string;
  title: string;
  summary: string;
  targetAudience: string;
  keywords: string[];
  scores: DirectionScoreFactors;
  /** 加权总分 */
  totalScore: number;
  /** 方向依赖的事实标识 */
  claimIds: string[];
  /** 排序时的评分输入快照（审计用） */
  scoringInputs: {
    thresholdSnapshot: Record<string, number>;
    rankedAt: string;
  };
}

/** 自动选向决策结果 */
export interface AutoDirectionDecision {
  selectedDirectionId?: string;
  /** 未选择方向时的原因（门槛明细） */
  unmetThresholds: string[];
  /** 决策输入快照（审计用） */
  decidedAt: string;
  evaluatedDirectionIds: string[];
}

/** 方向是否满足全部自动门槛（阈值由 policy.ts 提供） */
export function meetsDirectionThresholds(
  direction: Pick<DirectionOption, 'scores' | 'totalScore' | 'claimIds'>,
  thresholds: {
    minSourceCoverage: number;
    minDirectionScore: number;
    maxRisk: number;
  },
  claims: readonly Pick<Claim, 'sourceIds'>[],
): boolean {
  const coverage = computeClaimCoverage(direction, claims);
  return (
    coverage >= thresholds.minSourceCoverage &&
    direction.totalScore >= thresholds.minDirectionScore &&
    direction.scores.risk <= thresholds.maxRisk
  );
}

/** 计算方向依赖事实的来源覆盖率 */
function computeClaimCoverage(
  _direction: Pick<DirectionOption, 'claimIds'>,
  claims: readonly Pick<Claim, 'sourceIds'>[],
): number {
  if (claims.length === 0) {
    return 0;
  }
  const supported = claims.filter((claim) => claim.sourceIds.length > 0).length;
  return supported / claims.length;
}
