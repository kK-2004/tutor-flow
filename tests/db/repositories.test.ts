import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  appendAuditEvent,
  appendWorkflowEvent,
  approveDraft,
  createDraftRevision,
  createRun,
  IdempotencyConflictError,
  listEventsAfter,
  OptimisticLockError,
  RevisionConflictError,
  saveDraftRevision,
  StateGuardError,
  transitionRunStatus,
  platformAccounts,
} from '@tutor-flow/db';

import { createTestDb, setupTestDatabase, truncateAll } from './setup';
import type { DbClient } from '@tutor-flow/db';

/** 测试夹具：默认小红书账号（固定主键，满足发布任务外键） */
const TEST_ACCOUNT_ID = '00000000-0000-0000-0000-000000000001';

async function ensureTestAccount(client: DbClient): Promise<void> {
  await client.db
    .insert(platformAccounts)
    .values({
      id: TEST_ACCOUNT_ID,
      alias: '测试账号',
      platform: 'xiaohongshu',
      secretRef: 'env:XHS_ACCOUNT_TEST',
      autoPublishAllowed: false,
    })
    .onConflictDoNothing();
}

/**
 * 迁移与仓储集成测试：唯一性、状态转换约束、修订冲突、审计数据保留。
 * 依赖本地 SQLite（测试专用临时库）。
 */
let db: DbClient;

beforeAll(async () => {
  await setupTestDatabase();
  db = createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await truncateAll(db);
  await ensureTestAccount(db);
});

/** 通用运行任务创建输入 */
function runInput(caller: string, topic: string) {
  return {
    callerIdentity: caller,
    requestHash: `hash-${topic}`,
    topic,
    directionMode: 'manual' as const,
    publishMode: 'review' as const,
    platform: 'xiaohongshu' as const,
    accountId: '00000000-0000-0000-0000-000000000001',
    triggerType: 'manual' as const,
    triggeredBy: caller,
  };
}

describe('触发幂等与唯一约束', () => {
  it('相同幂等键与载荷重放返回原运行', async () => {
    const first = await createRun(db.db, {
      callerIdentity: 'scheduler:cron-1',
      idempotencyKey: 'key-1',
      requestHash: 'hash-a',
      ...runInput('scheduler:cron-1', '测试主题'),
      triggerType: 'scheduler',
    });
    expect(first.replayed).toBe(false);

    const second = await createRun(db.db, {
      callerIdentity: 'scheduler:cron-1',
      idempotencyKey: 'key-1',
      requestHash: 'hash-a',
      ...runInput('scheduler:cron-1', '测试主题'),
      triggerType: 'scheduler',
    });
    expect(second.replayed).toBe(true);
    expect(second.runId).toBe(first.runId);
  });

  it('相同幂等键不同载荷返回冲突', async () => {
    const input = {
      callerIdentity: 'scheduler:cron-1',
      idempotencyKey: 'key-1',
      ...runInput('scheduler:cron-1', '测试主题'),
      triggerType: 'scheduler' as const,
    };
    await createRun(db.db, { ...input, requestHash: 'hash-a' });
    await expect(createRun(db.db, { ...input, requestHash: 'hash-b' })).rejects.toThrow(
      IdempotencyConflictError,
    );
  });

  it('无幂等键的创建各自独立', async () => {
    const first = await createRun(db.db, runInput('operator:op-1', '独立任务一'));
    const second = await createRun(db.db, runInput('operator:op-1', '独立任务二'));
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(false);
    expect(second.runId).not.toBe(first.runId);
  });
});

describe('运行状态转换约束', () => {
  async function seedRun(): Promise<string> {
    const result = await createRun(db.db, runInput('operator:op-2', '状态机测试'));
    return result.runId;
  }

  it('合法转换成功且版本递增', async () => {
    const runId = await seedRun();
    const run = await transitionRunStatus(db.db, runId, 'RESEARCHING', {
      expectedVersion: 1,
    });
    expect(run.status).toBe('RESEARCHING');
    expect(run.version).toBe(2);
  });

  it('非法转换被领域状态机拒绝', async () => {
    const runId = await seedRun();
    await expect(
      transitionRunStatus(db.db, runId, 'SUCCEEDED', { expectedVersion: 1 }),
    ).rejects.toThrow(StateGuardError);
  });

  it('过期版本号触发乐观锁冲突', async () => {
    const runId = await seedRun();
    await transitionRunStatus(db.db, runId, 'RESEARCHING', { expectedVersion: 1 });
    // 用旧版本号 1 再次转换 → 乐观锁冲突
    await expect(
      transitionRunStatus(db.db, runId, 'GENERATING', { expectedVersion: 1 }),
    ).rejects.toThrow(OptimisticLockError);
  });
});

describe('工作流事件持久化与重放', () => {
  it('seq 单调递增且可按 id 重放', async () => {
    const created = await createRun(db.db, runInput('operator:op-3', '事件重放测试'));
    const runId = created.runId;
    const event2 = await appendWorkflowEvent(db.db, runId, 'step.started', {
      stepType: 'SEARCH',
    });
    const event3 = await appendWorkflowEvent(db.db, runId, 'step.completed', {
      stepType: 'SEARCH',
    });
    expect(event2.seq).toBe(2);
    expect(event3.seq).toBe(3);

    // 模拟 Last-Event-ID：只取 id 大于 event2.id 的事件
    const replayed = await listEventsAfter(db.db, runId, event2.id);
    expect(replayed.map((e) => e.seq)).toEqual([3]);
  });
});

describe('草稿修订冲突与批准幂等', () => {
  async function seedDraft(): Promise<string> {
    const created = await createRun(db.db, runInput('operator:op-4', '草稿测试'));
    await createDraftRevision(db.db, {
      runId: created.runId,
      title: '标题',
      body: '正文内容',
      tags: ['标签'],
      mediaObjectKeys: ['media/cover.jpg'],
      claimUsages: [],
      createdBy: 'operator:op-4',
    });
    return created.runId;
  }

  it('过期版本保存抛修订冲突且不覆盖', async () => {
    const runId = await seedDraft();
    await saveDraftRevision(db.db, {
      runId,
      expectedRevision: 1,
      title: '新标题',
      savedBy: 'operator:op-4',
    });
    // 用过期版本 1 保存 → 冲突
    await expect(
      saveDraftRevision(db.db, {
        runId,
        expectedRevision: 1,
        title: '并发旧稿',
        savedBy: 'operator:op-4',
      }),
    ).rejects.toThrow(RevisionConflictError);
  });

  it('批准创建发布任务且重复批准返回原任务', async () => {
    const runId = await seedDraft();
    const approvalInput = {
      runId,
      expectedRevision: 1,
      approvedBy: 'operator:op-4',
      publishIdempotencyKey: 'publish-key-1',
      accountId: '00000000-0000-0000-0000-000000000001',
      policyVersion: 'xhs-policy@2026.09',
    };
    const first = await approveDraft(db.db, approvalInput);
    expect(first.created).toBe(true);

    const second = await approveDraft(db.db, approvalInput);
    expect(second.created).toBe(false);
    expect(second.publishJob.id).toBe(first.publishJob.id);
  });

  it('批准后不允许继续编辑', async () => {
    const runId = await seedDraft();
    await approveDraft(db.db, {
      runId,
      expectedRevision: 1,
      approvedBy: 'operator:op-4',
      publishIdempotencyKey: 'publish-key-2',
      accountId: '00000000-0000-0000-0000-000000000001',
      policyVersion: 'xhs-policy@2026.09',
    });
    await expect(
      saveDraftRevision(db.db, {
        runId,
        expectedRevision: 1,
        title: '批准后再改',
        savedBy: 'operator:op-4',
      }),
    ).rejects.toThrow(StateGuardError);
  });
});

describe('审计数据保留（不可变）', () => {
  it('审计事件禁止更新与删除', async () => {
    const event = await appendAuditEvent(db.db, {
      actorType: 'operator',
      actorId: 'operator:op-5',
      action: 'test.action',
      resourceType: 'workflow_run',
      resourceId: '00000000-0000-0000-0000-000000000009',
      payload: { note: '审计保留测试' },
    });
    expect(event.id).toBeGreaterThan(0);

    await expect(
      db.client.execute(`UPDATE audit_event SET action = 'tampered'`),
    ).rejects.toThrow(/只追加表/);
    await expect(
      db.client.execute(`DELETE FROM audit_event WHERE id = ${event.id}`),
    ).rejects.toThrow(/只追加表/);
  });

  it('审计载荷中的敏感键被脱敏', async () => {
    const event = await appendAuditEvent(db.db, {
      actorType: 'system',
      actorId: 'system:test',
      action: 'test.redact',
      resourceType: 'platform_account',
      resourceId: 'acct-1',
      payload: { secretRef: 'env:XHS_COOKIE_JAR', cookieValue: 'abc', note: '可见' },
    });
    const payload = event.payload as Record<string, string>;
    expect(payload['secretRef']).toBe('[REDACTED]');
    expect(payload['cookieValue']).toBe('[REDACTED]');
    expect(payload['note']).toBe('可见');
  });
});
