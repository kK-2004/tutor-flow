import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimPendingOutbox, enqueueOutbox, type DbClient } from '@tutor-flow/db';
import { createTestDb, setupTestDatabase } from './setup.js';

let db: DbClient;
beforeAll(async () => {
  await setupTestDatabase();
  db = createTestDb();
  await db.ready;
});
afterAll(async () => {
  await db.close();
});

describe('停用发布后的历史发件箱', () => {
  it('旧发布请求保留供核对，但不会进入分发批次', async () => {
    const publish = await enqueueOutbox(db.db, {
      eventName: 'publish.queued',
      aggregateType: 'publish_job',
      aggregateId: 'legacy',
      payload: { job: { queue: 'publishing', name: 'publish-job', data: {} } },
    });
    const workflow = await enqueueOutbox(db.db, {
      eventName: 'workflow.step.SEARCH',
      aggregateType: 'workflow_run',
      aggregateId: 'new',
      payload: { job: { queue: 'workflow', name: 'workflow-step', data: {} } },
    });
    const pending = await claimPendingOutbox(db.db, { limit: 10 });
    expect(pending.map((item) => item.id)).toContain(workflow.id);
    expect(pending.map((item) => item.id)).not.toContain(publish.id);
  });
});
