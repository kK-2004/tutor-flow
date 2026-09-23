/**
 * API 认证边界。
 *
 * 两类主体：
 * - 运营人员：Bearer OPERATOR_TOKEN（生产环境将由网关/OIDC 替代，
 *   见设计文档待确认事项；主体标识可经 X-Operator-Id 传递）；
 * - 外部调度器：Bearer SCHEDULER_TOKEN（触发必须携带幂等键）。
 *
 * 令牌未配置时对应触发方式整体不可用，绝不允许匿名写操作。
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import type { ApiEnv } from '@tutor-flow/config/server';
import { findAdminSession, type AdminRole, type DbClient } from '@tutor-flow/db';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** 已认证主体 */
export interface AuthenticatedActor {
  kind: 'operator' | 'scheduler';
  /** 操作主体标识（审计用） */
  id: string;
  userId?: string;
  username?: string;
  role?: AdminRole;
  sessionTokenHash?: string;
}

export const ADMIN_SESSION_COOKIE = 'tutor_flow_session';

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function cookieToken(request: FastifyRequest): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const item of header.split(';')) {
    const [name, ...value] = item.trim().split('=');
    if (name === ADMIN_SESSION_COOKIE) return decodeURIComponent(value.join('='));
  }
  return null;
}

/** 判断是否为运营人员主体，供资源级路由守卫复用。 */
export function isOperator(
  actor: AuthenticatedActor | undefined,
): actor is AuthenticatedActor & { kind: 'operator' } {
  return actor?.kind === 'operator';
}

/** 判断是否为外部调度器主体。 */
export function isScheduler(
  actor: AuthenticatedActor | undefined,
): actor is AuthenticatedActor & { kind: 'scheduler' } {
  return actor?.kind === 'scheduler';
}

declare module 'fastify' {
  interface FastifyRequest {
    actor?: AuthenticatedActor;
  }
}

/** 从请求提取 Bearer 令牌 */
function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers['authorization'];
  if (header === undefined || Array.isArray(header)) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() ?? null;
}

/** 使用定长比较避免令牌比较产生明显的时序差异。 */
function tokenMatches(actual: string, expected: string | undefined): boolean {
  if (expected === undefined || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

/** 生成认证 preHandler：运营与调度器令牌均可通过 */
export function requireAuthenticated(
  env: ApiEnv,
  db: DbClient,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    const sessionToken = cookieToken(request);
    if (sessionToken !== null) {
      const sessionTokenHash = hashSessionToken(sessionToken);
      const session = await findAdminSession(db.db, sessionTokenHash);
      if (session !== null) {
        request.actor = {
          kind: 'operator',
          id: `admin_user:${session.userId}`,
          userId: session.userId,
          username: session.username,
          role: session.role,
          sessionTokenHash,
        };
        return;
      }
    }
    const token = bearerToken(request);
    if (token === null) {
      await reply.code(401).send({ error: '缺少 Bearer 凭据' });
      return;
    }
    if (tokenMatches(token, env.OPERATOR_TOKEN)) {
      const headerActor = request.headers['x-operator-id'];
      const actorId =
        typeof headerActor === 'string' && headerActor.trim() !== ''
          ? `operator:${headerActor.trim()}`
          : 'operator';
      request.actor = { kind: 'operator', id: actorId };
      return;
    }
    if (tokenMatches(token, env.SCHEDULER_TOKEN)) {
      request.actor = { kind: 'scheduler', id: 'scheduler' };
      return;
    }
    await reply.code(401).send({ error: '凭据无效' });
  };
}

/** SSE 专用：允许通过 access_token 查询参数认证（EventSource 无法设置请求头） */
export async function authenticatedByQueryOrHeader(
  env: ApiEnv,
  db: DbClient,
  request: FastifyRequest,
): Promise<AuthenticatedActor | null> {
  const sessionToken = cookieToken(request);
  if (sessionToken !== null) {
    const sessionTokenHash = hashSessionToken(sessionToken);
    const session = await findAdminSession(db.db, sessionTokenHash);
    if (session !== null) {
      return {
        kind: 'operator',
        id: `admin_user:${session.userId}`,
        userId: session.userId,
        username: session.username,
        role: session.role,
        sessionTokenHash,
      };
    }
  }
  const headerToken = bearerToken(request);
  if (headerToken !== null) {
    if (tokenMatches(headerToken, env.OPERATOR_TOKEN)) {
      return { kind: 'operator', id: 'operator' };
    }
    if (tokenMatches(headerToken, env.SCHEDULER_TOKEN)) {
      return { kind: 'scheduler', id: 'scheduler' };
    }
    return null;
  }
  const query = request.query as { access_token?: string };
  const queryToken = query['access_token'];
  if (typeof queryToken === 'string' && queryToken !== '') {
    if (tokenMatches(queryToken, env.OPERATOR_TOKEN)) {
      return { kind: 'operator', id: 'operator' };
    }
    if (tokenMatches(queryToken, env.SCHEDULER_TOKEN)) {
      return { kind: 'scheduler', id: 'scheduler' };
    }
  }
  return null;
}
