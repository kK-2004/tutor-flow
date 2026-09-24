import { describe, expect, it } from 'vitest';
import { DEFAULT_XIAOHONGSHU_POLICY } from '@tutor-flow/domain';
import {
  hasBlockingIssues,
  planNextStep,
  validateXhsContent,
} from '@tutor-flow/workflow';

describe('纯内容生产闭环', () => {
  it('自动与人工任务都停在草稿审核，不进入发布步骤', () => {
    for (const publishMode of ['auto', 'review'] as const) {
      const next = planNextStep({
        completedStep: 'CREATE_DRAFT',
        directionMode: 'auto',
        publishMode,
        requireHumanApproval: false,
      });
      expect(next).toMatchObject({ status: 'NEEDS_REVIEW', stop: 'NEEDS_REVIEW' });
      expect(next.nextStep).toBeUndefined();
    }
  });

  it('纯文字小红书草稿可校验，隐私信息仍阻断审核', () => {
    const base = {
      title: 'PG17 升级要点',
      body: 'PostgreSQL 17 的 vacuum 性能提升约两倍，升级前请阅读官方说明。',
      tags: ['数据库', '升级'],
      mediaObjectKeys: [],
      aigcDisclosure: 'disclosed',
      claimUsages: [{ claimId: 'claim-1' }],
    };
    const source = [{ claimId: 'claim-1', hasSource: true }];
    expect(
      hasBlockingIssues(validateXhsContent(base, DEFAULT_XIAOHONGSHU_POLICY, source)),
    ).toBe(false);
    const unsafe = { ...base, body: `${base.body} 联系 13812345678 获取帮助。` };
    expect(
      hasBlockingIssues(validateXhsContent(unsafe, DEFAULT_XIAOHONGSHU_POLICY, source)),
    ).toBe(true);
  });
});
