import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  appendWorkflowEvent,
  approveDraft,
  claimSources,
  claims,
  computePublishIdempotencyKey,
  createRun,
  draftRevisions,
  outboxRecords,
  platformAccounts,
  publishJobs,
  requireRun,
  sourceDocuments,
  type DbClient,
} from '@tutor-flow/db';
import { DEFAULT_XIAOHONGSHU_POLICY } from '@tutor-flow/domain';
import { FakePublisherAdapter } from '@tutor-flow/integrations';
import { hasBlockingIssues, validateXhsContent } from '@tutor-flow/workflow';
import { planNextStep } from '@tutor-flow/workflow';
import { createPublishLanes } from '../../apps/worker/src/publisher/lanes.js';
import {
  createPublishHandler,
  createVerifyPublicationHandler,
} from '../../apps/worker/src/steps/publishing.js';
import { createTestDb, setupTestDatabase, truncateAll } from '../db/setup';

/** 模拟集成端到端场景：调度、人工选向、草稿批准、发布回执和重复投递。 */
describe('模拟内容生产闭环', () => {
  let db: DbClient;
  const accountId = 'a1000000-0000-4000-8000-000000000001';
  const claimId = 'a2000000-0000-4000-8000-000000000001';
  const sourceId = 'a3000000-0000-4000-8000-000000000001';
  const draftId = 'a4000000-0000-4000-8000-000000000001';

  beforeAll(async () => {
    await setupTestDatabase();
    db = createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await truncateAll(db);
  });

  it('幂等调度与批准产生唯一发布队列记录', async () => {
    await db.db
      .insert(platformAccounts)
      .values({ id: accountId, alias: '闭环测试账号', secretRef: 'env:XHS_E2E' });
    const first = await createRun(db.db, {
      callerIdentity: 'scheduler:e2e',
      idempotencyKey: 'e2e-daily-1',
      requestHash: 'same-payload',
      topic: '闭环测试主题',
      directionMode: 'manual',
      publishMode: 'review',
      platform: 'xiaohongshu',
      accountId,
      triggerType: 'scheduler',
      triggeredBy: 'scheduler:e2e',
    });
    const replay = await createRun(db.db, {
      callerIdentity: 'scheduler:e2e',
      idempotencyKey: 'e2e-daily-1',
      requestHash: 'same-payload',
      topic: '闭环测试主题',
      directionMode: 'manual',
      publishMode: 'review',
      platform: 'xiaohongshu',
      accountId,
      triggerType: 'scheduler',
      triggeredBy: 'scheduler:e2e',
    });
    expect(replay.replayed).toBe(true);
    expect(replay.runId).toBe(first.runId);

    const actualRunId = first.runId;
    await db.db.insert(sourceDocuments).values({
      id: sourceId,
      runId: actualRunId,
      canonicalUrl: 'https://example.com/source',
      urlHash: 'source-hash',
      title: '测试来源',
      domain: 'example.com',
      language: 'zh',
      isPrimary: true,
      fetchStatus: 'FETCHED',
    });
    await db.db.insert(claims).values({
      id: claimId,
      runId: actualRunId,
      statement: '测试事实',
      confidence: 0.95,
      primarySourceSupported: true,
    });
    await db.db.insert(claimSources).values({ claimId, sourceId });
    await db.db.insert(draftRevisions).values({
      id: draftId,
      runId: actualRunId,
      revision: 1,
      status: 'PENDING_REVIEW',
      title: '闭环测试标题',
      body: '这是一段用于端到端测试的合规正文，包含测试事实。',
      tags: ['测试'],
      mediaObjectKeys: ['media/cover.png'],
      claimUsages: [{ claimId, locator: 'body' }],
      createdBy: 'system:e2e',
    });
    const approved = await approveDraft(db.db, {
      runId: actualRunId,
      expectedRevision: 1,
      approvedBy: 'operator:e2e',
      accountId,
      publishIdempotencyKey: computePublishIdempotencyKey({
        accountId,
        artifactVersion: 1,
      }),
      policyVersion: 'xhs-policy@2026.09',
    });
    expect(approved.created).toBe(true);
    const repeated = await approveDraft(db.db, {
      runId: actualRunId,
      expectedRevision: 1,
      approvedBy: 'operator:e2e',
      accountId,
      publishIdempotencyKey: computePublishIdempotencyKey({
        accountId,
        artifactVersion: 1,
      }),
      policyVersion: 'xhs-policy@2026.09',
    });
    expect(repeated.created).toBe(false);
    expect(await db.db.select().from(publishJobs)).toHaveLength(1);
    const publishOutbox = await db.db.select().from(outboxRecords);
    expect(publishOutbox.some((row) => row.eventName === 'publish.queued')).toBe(true);
  });

  it('模拟发布回执与 SSE 事件可以重放，重复消费不产生第二次发布', async () => {
    await db.db
      .insert(platformAccounts)
      .values({ id: accountId, alias: '闭环核验账号', secretRef: 'env:XHS_E2E' });
    const created = await createRun(db.db, {
      callerIdentity: 'operator:e2e',
      requestHash: 'flow',
      topic: '核验主题',
      directionMode: 'manual',
      publishMode: 'review',
      platform: 'xiaohongshu',
      accountId,
      triggerType: 'manual',
      triggeredBy: 'operator:e2e',
    });
    const actualRunId = created.runId;
    await db.db.insert(sourceDocuments).values({
      id: sourceId,
      runId: actualRunId,
      canonicalUrl: 'https://example.com/source-2',
      urlHash: 'source-hash-2',
      title: '测试来源',
      domain: 'example.com',
      language: 'zh',
      isPrimary: true,
      fetchStatus: 'FETCHED',
    });
    await db.db.insert(claims).values({
      id: claimId,
      runId: actualRunId,
      statement: '测试事实二',
      confidence: 0.95,
      primarySourceSupported: true,
    });
    await db.db.insert(claimSources).values({ claimId, sourceId });
    await db.db.insert(draftRevisions).values({
      id: draftId,
      runId: actualRunId,
      revision: 1,
      status: 'PENDING_REVIEW',
      title: '核验标题',
      body: '这是一段用于发布核验测试的合规正文，足够长。',
      tags: ['核验'],
      mediaObjectKeys: ['media/cover.png'],
      claimUsages: [{ claimId, locator: 'body' }],
      createdBy: 'system:e2e',
    });
    const approved = await approveDraft(db.db, {
      runId: actualRunId,
      expectedRevision: 1,
      approvedBy: 'operator:e2e',
      accountId,
      publishIdempotencyKey: 'e2e-publish-key',
      policyVersion: 'xhs-policy@2026.09',
    });
    const adapter = new FakePublisherAdapter();
    const deps = {
      db,
      adapter,
      lanes: createPublishLanes({ jitterRandom: () => 0 }),
      secrets: {
        resolveSecret: async () => 'memory-secret',
        hasSecret: async () => true,
      },
      jitterMs: 0,
    };
    const publish = createPublishHandler(deps);
    const verify = createVerifyPublicationHandler(deps);
    const restartedPublish = createPublishHandler({
      ...deps,
      lanes: createPublishLanes({ jitterRandom: () => 0 }),
    });
    const run = await requireRun(db.db, actualRunId);
    await publish({
      data: { runId: actualRunId, stepType: 'PUBLISH', attemptNo: 1 },
      run,
      attempt: {} as never,
    });
    await restartedPublish({
      data: { runId: actualRunId, stepType: 'PUBLISH', attemptNo: 2 },
      run,
      attempt: {} as never,
    });
    await verify({
      data: { runId: actualRunId, stepType: 'VERIFY_PUBLICATION', attemptNo: 1 },
      run,
      attempt: {} as never,
    });
    expect(adapter.publishedCalls).toHaveLength(1);
    await appendWorkflowEvent(db.db, actualRunId, 'run.succeeded', {});
    const events = await (
      await import('@tutor-flow/db')
    ).listEventsAfter(db.db, actualRunId, 0, 20);
    expect(events.some((event) => event.name === 'run.succeeded')).toBe(true);
    expect(approved.publishJob.id).toBeDefined();
  });

  it('自动模式通过质量门槛后继续校验，安全门槛失败则停在人工处理', () => {
    const next = planNextStep({
      completedStep: 'CREATE_DRAFT',
      directionMode: 'auto',
      publishMode: 'auto',
      requireHumanApproval: false,
    });
    expect(next.nextStep).toBe('VALIDATE_PUBLISH');
    const valid = validateXhsContent(
      {
        title: '合规自动模式示例',
        body: '这是一段包含已核验事实的合规正文。',
        tags: ['测试'],
        mediaObjectKeys: ['media/cover.png'],
        aigcDisclosure: 'disclosed',
        claimUsages: [{ claimId: claimId }],
      },
      DEFAULT_XIAOHONGSHU_POLICY,
      [{ claimId, hasSource: true }],
    );
    expect(hasBlockingIssues(valid)).toBe(false);
    const unsafe = validateXhsContent(
      {
        title: '不合规示例',
        body: '这是一段包含手机号 13812345678 的正文。',
        tags: ['测试'],
        mediaObjectKeys: ['media/cover.png'],
        aigcDisclosure: 'disclosed',
        claimUsages: [{ claimId }],
      },
      DEFAULT_XIAOHONGSHU_POLICY,
      [{ claimId, hasSource: true }],
    );
    expect(hasBlockingIssues(unsafe)).toBe(true);
  });
});
