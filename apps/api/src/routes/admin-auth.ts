/** 管理后台登录、用户与密码管理路由。 */
import { randomBytes } from 'node:crypto';

import type { ApiEnv } from '@tutor-flow/config/server';
import {
  appendAuditEvent,
  createAdminSession,
  createAdminUser,
  deleteAdminSession,
  deleteAdminSessionsForUser,
  findAdminUser,
  findAdminUserByUsername,
  generateAdminPassword,
  hashAdminPassword,
  listAdminUsers,
  updateAdminPassword,
  verifyAdminPassword,
  type DbClient,
} from '@tutor-flow/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  ADMIN_SESSION_COOKIE,
  hashSessionToken,
  isOperator,
  requireAuthenticated,
} from '../lib/auth.js';
import { parseBody } from '../lib/http.js';

const SESSION_TTL_SECONDS = 90 * 24 * 60 * 60;
const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .regex(/^[A-Za-z0-9._-]+$/, '用户名只能包含字母、数字、点、下划线和连字符');
const passwordSchema = z.string().min(10).max(128);

function sessionCookie(request: FastifyRequest, token: string, maxAge: number): string {
  const secure = request.protocol === 'https' ? '; Secure' : '';
  return `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function safeUser(user: { id: string; username: string; role: 'SUPER_ADMIN' | 'ADMIN' }) {
  return { id: user.id, username: user.username, role: user.role };
}

async function issueSession(
  db: DbClient,
  request: FastifyRequest,
  reply: import('fastify').FastifyReply,
  userId: string,
): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  await createAdminSession(db.db, {
    tokenHash: hashSessionToken(token),
    userId,
    expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
  });
  reply.header('set-cookie', sessionCookie(request, token, SESSION_TTL_SECONDS));
}

export function registerAdminAuthRoutes(
  app: FastifyInstance,
  options: { db: DbClient; env: ApiEnv },
): void {
  const { db, env } = options;
  const authenticate = requireAuthenticated(env, db);

  app.post('/api/v1/auth/login', async (request, reply) => {
    const body = parseBody(
      z
        .object({ username: usernameSchema, password: z.string().min(1).max(128) })
        .strict(),
      request.body,
    );
    const user = await findAdminUserByUsername(db.db, body.username);
    if (user === null) {
      await hashAdminPassword(body.password);
      return reply.code(401).send({ error: '用户名或密码错误' });
    }
    if (!(await verifyAdminPassword(body.password, user.passwordHash))) {
      return reply.code(401).send({ error: '用户名或密码错误' });
    }
    await issueSession(db, request, reply, user.id);
    await appendAuditEvent(db.db, {
      actorType: 'operator',
      actorId: `admin_user:${user.id}`,
      action: 'admin.login',
      resourceType: 'admin_user',
      resourceId: user.id,
    });
    return reply.send({ user: safeUser(user) });
  });

  app.get('/api/v1/auth/me', { preHandler: authenticate }, async (request, reply) => {
    if (!isOperator(request.actor) || request.actor.userId === undefined) {
      return reply.code(401).send({ error: '请登录管理后台' });
    }
    return reply.send({
      user: {
        id: request.actor.userId,
        username: request.actor.username,
        role: request.actor.role,
      },
    });
  });

  app.post(
    '/api/v1/auth/logout',
    { preHandler: authenticate },
    async (request, reply) => {
      if (request.actor?.sessionTokenHash) {
        await deleteAdminSession(db.db, request.actor.sessionTokenHash);
      }
      reply.header('set-cookie', sessionCookie(request, '', 0));
      return reply.send({ ok: true });
    },
  );

  app.post(
    '/api/v1/auth/change-password',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = request.actor;
      if (!isOperator(actor) || actor.userId === undefined) {
        return reply.code(401).send({ error: '请登录管理后台' });
      }
      const body = parseBody(
        z
          .object({
            currentPassword: z.string().min(1).max(128),
            newPassword: passwordSchema,
          })
          .strict(),
        request.body,
      );
      const user = await findAdminUser(db.db, actor.userId);
      if (
        user === null ||
        !(await verifyAdminPassword(body.currentPassword, user.passwordHash))
      ) {
        return reply.code(400).send({ error: '当前密码不正确' });
      }
      await updateAdminPassword(
        db.db,
        user.id,
        await hashAdminPassword(body.newPassword),
      );
      await deleteAdminSessionsForUser(db.db, user.id);
      await issueSession(db, request, reply, user.id);
      await appendAuditEvent(db.db, {
        actorType: 'operator',
        actorId: actor.id,
        action: 'admin.password_changed',
        resourceType: 'admin_user',
        resourceId: user.id,
      });
      return reply.send({ ok: true });
    },
  );

  app.get('/api/v1/admin/users', { preHandler: authenticate }, async (request, reply) => {
    if (request.actor?.role !== 'SUPER_ADMIN' || request.actor.userId === undefined) {
      return reply.code(403).send({ error: '仅超级管理员可查看管理员列表' });
    }
    return reply.send({ items: await listAdminUsers(db.db) });
  });

  app.post(
    '/api/v1/admin/users',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = request.actor;
      if (actor?.role !== 'SUPER_ADMIN' || actor.userId === undefined) {
        return reply.code(403).send({ error: '仅超级管理员可创建管理员' });
      }
      const body = parseBody(
        z.object({ username: usernameSchema, password: passwordSchema }).strict(),
        request.body,
      );
      if ((await findAdminUserByUsername(db.db, body.username)) !== null) {
        return reply.code(409).send({ error: '用户名已存在' });
      }
      const created = await createAdminUser(db.db, {
        username: body.username,
        passwordHash: await hashAdminPassword(body.password),
        role: 'ADMIN',
        createdBy: actor.id,
      });
      await appendAuditEvent(db.db, {
        actorType: 'operator',
        actorId: actor.id,
        action: 'admin.created',
        resourceType: 'admin_user',
        resourceId: created.id,
        payload: { role: created.role },
      });
      return reply.code(201).send(safeUser(created));
    },
  );

  app.post(
    '/api/v1/admin/users/:id/reset-password',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = request.actor;
      if (actor?.role !== 'SUPER_ADMIN' || actor.userId === undefined) {
        return reply.code(403).send({ error: '仅超级管理员可重置管理员密码' });
      }
      const { id } = request.params as { id: string };
      const target = await findAdminUser(db.db, id);
      if (target === null) return reply.code(404).send({ error: '管理员不存在' });
      if (target.role !== 'ADMIN') {
        return reply.code(403).send({ error: '只能重置 ADMIN 的密码' });
      }
      const body = parseBody(
        z.discriminatedUnion('mode', [
          z.object({ mode: z.literal('random') }).strict(),
          z.object({ mode: z.literal('specified'), password: passwordSchema }).strict(),
        ]),
        request.body,
      );
      const password = body.mode === 'random' ? generateAdminPassword() : body.password;
      await updateAdminPassword(db.db, target.id, await hashAdminPassword(password));
      await deleteAdminSessionsForUser(db.db, target.id);
      await appendAuditEvent(db.db, {
        actorType: 'operator',
        actorId: actor.id,
        action: 'admin.password_reset',
        resourceType: 'admin_user',
        resourceId: target.id,
        payload: { mode: body.mode },
      });
      return reply.send({ ok: true, ...(body.mode === 'random' ? { password } : {}) });
    },
  );
}
