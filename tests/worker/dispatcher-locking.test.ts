import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, setupTestDatabase, truncateAll } from '../db/setup.js';
import { enqueueOutbox, type DbClient } from '@tutor-flow/db';
import { OutboxDispatcher } from '../../apps/worker/src/dispatcher.js';
import type { QueueRegistry } from '../../apps/worker/src/queues.js';

let db: DbClient;
let other: DbClient;
beforeAll(async () => {
  await setupTestDatabase();
  db = createTestDb();
  await db.ready;
  other = createTestDb();
  await other.ready;
});
afterAll(async () => {
  await other.close();
  await db.close();
});
beforeEach(async () => {
  await truncateAll(db);
});

const record = {
  eventName: 'test.dispatch',
  aggregateType: 'test',
  aggregateId: 'test',
  payload: { job: { queue: 'workflow', name: 'test', data: {} } },
};

describe('发件箱不跨 Redis 操作持有 SQLite 写锁', () => {
  it('等待队列响应期间，另一个连接仍能写库，同进程重复分发共享同一批次', async () => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const add = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          entered();
        }),
    );
    const queues = { workflow: { add } } as unknown as QueueRegistry;
    const row = await enqueueOutbox(db.db, record);
    const dispatcher = new OutboxDispatcher(db, queues);
    const pending = dispatcher.dispatchOnce();
    const duplicate = dispatcher.dispatchOnce();
    await waiting;
    try {
      await expect(
        enqueueOutbox(other.db, { ...record, aggregateId: 'other' }),
      ).resolves.toBeDefined();
      expect(add).toHaveBeenCalledTimes(1);
      expect(add.mock.calls[0]).toEqual(['test', {}, { jobId: `outbox-${row.id}` }]);
    } finally {
      release();
      await expect(pending).resolves.toBe(1);
      await expect(duplicate).resolves.toBe(1);
    }
  });

  it('空发件箱查询不会与另一连接的写事务竞争写锁', async () => {
    const tx = await other.client.transaction('write');
    try {
      const dispatcher = new OutboxDispatcher(db, {} as QueueRegistry);
      await expect(dispatcher.dispatchOnce()).resolves.toBe(0);
    } finally {
      await tx.rollback();
    }
  });

  it('WAL 已启用，连接池新连接也具有有限锁等待', async () => {
    expect(
      (await db.client.execute('PRAGMA journal_mode')).rows[0]?.['journal_mode'],
    ).toBe('wal');
    const tx = await db.client.transaction('read');
    try {
      expect((await db.client.execute('PRAGMA busy_timeout')).rows[0]?.['timeout']).toBe(
        1000,
      );
      expect((await tx.execute('PRAGMA busy_timeout')).rows[0]?.['timeout']).toBe(1000);
    } finally {
      await tx.rollback();
    }
  });
});
