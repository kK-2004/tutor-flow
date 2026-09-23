import { describe, expect, it } from 'vitest';

import { isRetryableErrorCategory, requiresHuman } from './errors.js';
import {
  assertTransition,
  canTransition,
  isHumanWaitStatus,
  isTerminalRunStatus,
} from './run.js';
import { isPlatform } from './platform.js';
import { DEFAULT_XIAOHONGSHU_POLICY } from './policy.js';

/**
 * 领域状态机与错误分类测试。
 */
describe('工作流状态机', () => {
  it('正常主干路径可推进到成功终态', () => {
    expect(canTransition('QUEUED', 'RESEARCHING')).toBe(true);
    expect(canTransition('RESEARCHING', 'WAITING_DIRECTION')).toBe(true);
    expect(canTransition('WAITING_DIRECTION', 'GENERATING')).toBe(true);
    expect(canTransition('GENERATING', 'NEEDS_REVIEW')).toBe(true);
    expect(canTransition('NEEDS_REVIEW', 'READY_TO_PUBLISH')).toBe(true);
    expect(canTransition('READY_TO_PUBLISH', 'PUBLISHING')).toBe(true);
    expect(canTransition('PUBLISHING', 'SUCCEEDED')).toBe(true);
  });

  it('发布进行中不允许取消（必须到达安全检查点）', () => {
    expect(canTransition('PUBLISHING', 'CANCELLED')).toBe(false);
  });

  it('终态之间与终态出边一律拒绝', () => {
    for (const terminal of ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const) {
      expect(isTerminalRunStatus(terminal)).toBe(true);
      expect(canTransition(terminal, 'QUEUED')).toBe(false);
      expect(canTransition(terminal, 'PUBLISHING')).toBe(false);
    }
    expect(canTransition('SUCCEEDED', 'FAILED')).toBe(false);
  });

  it('相同状态不算转换', () => {
    expect(canTransition('RESEARCHING', 'RESEARCHING')).toBe(false);
  });

  it('assertTransition 对非法转换抛错', () => {
    expect(() => assertTransition('QUEUED', 'SUCCEEDED')).toThrow(/非法的工作流状态转换/);
    expect(() => assertTransition('WAITING_DIRECTION', 'PUBLISHING')).toThrow();
  });

  it('人工停点状态判定', () => {
    expect(isHumanWaitStatus('WAITING_DIRECTION')).toBe(true);
    expect(isHumanWaitStatus('NEEDS_REVIEW')).toBe(true);
    expect(isHumanWaitStatus('NEEDS_HUMAN')).toBe(true);
    expect(isHumanWaitStatus('PUBLISHING')).toBe(false);
  });
});

describe('错误分类', () => {
  it('只有瞬时与限流错误允许自动重试', () => {
    expect(isRetryableErrorCategory('TRANSIENT')).toBe(true);
    expect(isRetryableErrorCategory('RATE_LIMITED')).toBe(true);
    expect(isRetryableErrorCategory('AUTH_EXPIRED')).toBe(false);
    expect(isRetryableErrorCategory('UNKNOWN_OUTCOME')).toBe(false);
  });

  it('授权、验证、策略、内容、选择器与未知结果必须人工处理', () => {
    for (const category of [
      'AUTH_EXPIRED',
      'CHALLENGE_REQUIRED',
      'VALIDATION',
      'POLICY',
      'CONTENT',
      'SELECTOR',
      'UNKNOWN_OUTCOME',
    ] as const) {
      expect(requiresHuman(category)).toBe(true);
    }
    expect(requiresHuman('TRANSIENT')).toBe(false);
  });
});

describe('平台与策略', () => {
  it('仅接受小红书平台', () => {
    expect(isPlatform('xiaohongshu')).toBe(true);
    expect(isPlatform('zhihu')).toBe(false);
    expect(isPlatform('wechat')).toBe(false);
  });

  it('默认策略强制人工审核与 AIGC 标识', () => {
    expect(DEFAULT_XIAOHONGSHU_POLICY.defaultReviewMode).toBe('review');
    expect(DEFAULT_XIAOHONGSHU_POLICY.requiresAigcDisclosure).toBe(true);
    expect(DEFAULT_XIAOHONGSHU_POLICY.media.requiresCover).toBe(true);
  });
});
