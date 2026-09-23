import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';

import { appendAuditEvent, auditEvents, type DbClient } from '@tutor-flow/db';
import { createTestDb, setupTestDatabase, truncateAll } from './setup';

/** 审计覆盖测试：主体明确、载荷脱敏且只追加。 */
describe('审计事件覆盖', () => {
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
  });

  it('记录外部操作主体并脱敏敏感字段', async () => {
    await appendAuditEvent(db.db, {
      actorType: 'operator',
      actorId: 'operator:test',
      action: 'publish.retried',
      resourceType: 'publish_job',
      resourceId: 'job-1',
      payload: { token: 'secret-value', reason: '人工恢复' },
    });
    const rows = await db.db.select().from(auditEvents);
    expect(rows[0]?.actorId).toBe('operator:test');
    expect(JSON.stringify(rows[0]?.payload)).not.toContain('secret-value');
  });

  it('关键人工与外部动作都保留明确主体', async () => {
    const actions = [
      'setting.updated',
      'direction.selected',
      'draft.edited',
      'draft.approved',
      'publish.attempted',
      'publish.retried',
      'publish.verified',
      'account.human_attention_resolved',
    ];
    for (const action of actions) {
      await appendAuditEvent(db.db, {
        actorType: action.startsWith('publish.') ? 'worker' : 'operator',
        actorId: action.startsWith('publish.') ? 'publisher-worker' : 'operator:test',
        action,
        resourceType: 'test_resource',
        resourceId: action,
        payload: { cookie: 'not-persisted', action },
      });
    }
    const rows = await db.db.select().from(auditEvents);
    expect(rows).toHaveLength(actions.length);
    expect(rows.every((row) => row.actorId !== '')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('not-persisted');
  });
});
