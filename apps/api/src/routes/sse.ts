/**
 * 工作流事件 SSE 流。
 *
 * - 事件先持久化再推送，id 为全局单调递增（Last-Event-ID 依据）；
 * - 客户端重连先补发持久化事件再推新事件；
 * - 心跳为注释帧，不改变工作流状态；
 * - 已终态运行：补发历史与终态事件后关闭连接。
 */
import { isTerminalRunStatus } from '@tutor-flow/domain';
import { listEventsAfter, requireRun, NotFoundError } from '@tutor-flow/db';
import type { DbClient } from '@tutor-flow/db';
import type { ApiEnv } from '@tutor-flow/config/server';
import type { FastifyInstance } from 'fastify';

import { authenticatedByQueryOrHeader, isOperator } from '../lib/auth.js';

/** 轮询新事件的间隔（毫秒） */
const POLL_INTERVAL_MS = 1_000;
/** 心跳间隔（毫秒） */
const HEARTBEAT_INTERVAL_MS = 15_000;

export interface SseRoutesOptions {
  db: DbClient;
  env: ApiEnv;
}

export function registerSseRoutes(app: FastifyInstance, options: SseRoutesOptions): void {
  const { db, env } = options;

  app.get('/api/v1/runs/:id/events/stream', async (request, reply) => {
    // SSE 认证：请求头或 access_token 查询参数
    const actor = await authenticatedByQueryOrHeader(env, db, request);
    if (actor === null || !isOperator(actor)) {
      return reply.code(401).send({ error: '缺少有效凭据' });
    }
    const { id } = request.params as { id: string };

    let afterId: number | undefined;
    const headerId = request.headers['last-event-id'];
    if (typeof headerId === 'string' && /^\d+$/.test(headerId.trim())) {
      afterId = Number(headerId.trim());
    }
    const query = request.query as { lastEventId?: string };
    if (afterId === undefined && typeof query['lastEventId'] === 'string') {
      const value = query['lastEventId'] ?? '';
      if (/^\d+$/.test(value)) {
        afterId = Number(value);
      }
    }

    // 运行必须存在
    try {
      await requireRun(db.db, id);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return reply.code(404).send({ error: error.message });
      }
      throw error;
    }

    // 接管原始响应（Fastify hijack）
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    let closed = false;
    const close = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      raw.end();
    };
    request.raw.on('close', close);
    raw.on('error', close);

    const writeFrame = (id: number, name: string, payload: unknown): void => {
      raw.write(`id: ${id}\nevent: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    const writeComment = (text: string): void => {
      raw.write(`: ${text}\n\n`);
    };

    // 补发持久化事件
    const run = await requireRun(db.db, id);
    let lastSentId = afterId ?? 0;
    const backlog = await listEventsAfter(db.db, id, lastSentId, 500);
    for (const event of backlog) {
      writeFrame(event.id, event.name, event.payload);
      lastSentId = event.id;
    }

    // 终态运行：补发完成后关闭
    if (isTerminalRunStatus(run.status)) {
      writeComment('stream closed: terminal run');
      close();
      return;
    }

    writeComment('stream open');

    // 周期轮询新事件（低并发首期采用轮询；事件均来自持久化存储）
    const poll = setInterval(async () => {
      if (closed) {
        return;
      }
      try {
        const fresh = await listEventsAfter(db.db, id, lastSentId, 500);
        for (const event of fresh) {
          writeFrame(event.id, event.name, event.payload);
          lastSentId = event.id;
        }
        if (fresh.length > 0) {
          const current = await requireRun(db.db, id);
          if (isTerminalRunStatus(current.status)) {
            writeComment('stream closed: terminal run');
            close();
          }
        }
      } catch {
        // 单次轮询失败忽略，下一轮重试
      }
    }, POLL_INTERVAL_MS);

    const heartbeat = setInterval(() => {
      if (closed) {
        return;
      }
      writeComment('heartbeat');
    }, HEARTBEAT_INTERVAL_MS);

    raw.on('close', () => {
      clearInterval(poll);
      clearInterval(heartbeat);
    });
    raw.on('error', () => {
      clearInterval(poll);
      clearInterval(heartbeat);
    });
  });
}
