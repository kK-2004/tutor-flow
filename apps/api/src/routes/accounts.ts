/**
 * 小红书账号路由（任务 6.1）：
 * 列表/创建/自动发布策略/授权健康检查。
 *
 * 安全约定：任何响应不包含 secretRef 与凭据明文（仅展示
 * 已配置/未配置状态）；凭据经密钥提供器短时解析后交给适配器。
 */
import {
  createXhsMcpSessionClient,
  type McpToolCaller,
  type PublisherAdapter,
} from '@tutor-flow/integrations';
import {
  appendAuditEvent,
  createAccount,
  clearAccountHumanAttention,
  findAccount,
  listAccounts,
  toSafeAccountView,
  updateAccountAutoPublish,
  updateAccountHealth,
  updateAccountPublishingLimits,
} from '@tutor-flow/db';
import type { DbClient } from '@tutor-flow/db';
import type { ApiEnv } from '@tutor-flow/config/server';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { isOperator, requireAuthenticated } from '../lib/auth.js';
import { parseBody } from '../lib/http.js';

export interface AccountRoutesOptions {
  db: DbClient;
  env: ApiEnv;
  /** 发布适配器：未配置地址或绑定账号时授权检查返回 503 */
  adapter: PublisherAdapter | null;
  /** MCP 会话工具：扫码登录不依赖账号记录是否已绑定。 */
  mcpCallTool?: McpToolCaller | null;
  /** 密钥提供器（解析账号凭据用） */
  secrets: {
    resolveSecret(ref: string): Promise<string>;
  } | null;
}

export function registerAccountRoutes(
  app: FastifyInstance,
  options: AccountRoutesOptions,
): void {
  const { db, env, adapter, secrets } = options;
  const authenticate = requireAuthenticated(env, db);
  const sessionClient = options.mcpCallTool
    ? createXhsMcpSessionClient(options.mcpCallTool)
    : null;

  app.post(
    '/api/v1/xiaohongshu/session/login-qrcode',
    { preHandler: authenticate },
    async (request, reply) => {
      if (!isOperator(request.actor)) {
        return reply.code(403).send({ error: '仅运营人员可发起账号登录' });
      }
      if (sessionClient === null) {
        return reply.code(503).send({ error: '小红书 MCP 尚未配置' });
      }
      const result = await sessionClient.getLoginQrcode();
      await appendAuditEvent(db.db, {
        actorType: 'operator',
        actorId: request.actor.id,
        action: 'account.login_started',
        resourceType: 'platform_account_session',
        resourceId: env.XHS_MCP_ACCOUNT_ID ?? 'xiaohongshu-sidecar',
        payload: { alreadyLoggedIn: result.alreadyLoggedIn },
      });
      return reply.send(result);
    },
  );

  app.post(
    '/api/v1/xiaohongshu/session/check',
    { preHandler: authenticate },
    async (request, reply) => {
      if (!isOperator(request.actor)) {
        return reply.code(403).send({ error: '仅运营人员可检查账号登录状态' });
      }
      if (sessionClient === null) {
        return reply.code(503).send({ error: '小红书 MCP 尚未配置' });
      }
      const result = await sessionClient.checkLoginStatus();
      const account =
        env.XHS_MCP_ACCOUNT_ID === undefined
          ? null
          : await findAccount(db.db, env.XHS_MCP_ACCOUNT_ID);
      if (account !== null) {
        await updateAccountHealth(db.db, account.id, {
          health: result.loggedIn ? 'HEALTHY' : 'AUTH_REQUIRED',
          note: result.loggedIn ? 'MCP 容器登录状态正常' : '上游容器未登录，请扫码登录',
          needsHumanAttention: !result.loggedIn,
        });
      }
      return reply.send(result);
    },
  );

  // 账号列表（脱敏）
  app.get(
    '/api/v1/xiaohongshu/accounts',
    { preHandler: authenticate },
    async (_request, reply) => {
      if (!isOperator(_request.actor)) {
        return reply.code(403).send({ error: '仅运营人员可查看账号列表' });
      }
      const accounts = await listAccounts(db.db, 'xiaohongshu');
      return reply.send({
        items: accounts.map(toSafeAccountView),
        total: accounts.length,
      });
    },
  );

  // 创建账号
  app.post(
    '/api/v1/xiaohongshu/accounts',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = request.actor;
      if (actor === undefined || actor.kind !== 'operator') {
        return reply.code(403).send({ error: '仅运营人员可创建账号' });
      }
      const body = parseBody(
        z
          .object({
            alias: z.string().trim().min(1).max(50),
            secretRef: z.string().trim().min(4).max(200),
          })
          .strict(),
        request.body,
      );
      const account = await createAccount(db.db, body);
      await appendAuditEvent(db.db, {
        actorType: 'operator',
        actorId: actor.id,
        action: 'account.created',
        resourceType: 'platform_account',
        resourceId: account.id,
        payload: { alias: account.alias, platform: account.platform },
      });
      await reply.code(201).send(toSafeAccountView(account));
    },
  );

  // 更新自动发布策略
  app.post(
    '/api/v1/xiaohongshu/accounts/:id/auto-publish',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = request.actor;
      if (actor === undefined || actor.kind !== 'operator') {
        return reply.code(403).send({ error: '仅运营人员可调整发布策略' });
      }
      const { id } = request.params as { id: string };
      const body = parseBody(z.object({ allowed: z.boolean() }).strict(), request.body);
      const account = await updateAccountAutoPublish(db.db, id, body.allowed);
      await appendAuditEvent(db.db, {
        actorType: 'operator',
        actorId: actor.id,
        action: 'account.auto_publish_updated',
        resourceType: 'platform_account',
        resourceId: account.id,
        payload: { allowed: body.allowed },
      });
      return reply.send(toSafeAccountView(account));
    },
  );

  // 更新账号级并发、令牌桶和抖动前的时间窗口配置。
  app.patch(
    '/api/v1/xiaohongshu/accounts/:id/limits',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = request.actor;
      if (actor === undefined || actor.kind !== 'operator') {
        return reply.code(403).send({ error: '仅运营人员可调整账号限流' });
      }
      const { id } = request.params as { id: string };
      const body = parseBody(
        z
          .object({
            concurrency: z.number().int().min(1).max(4),
            tokensPerWindow: z.number().int().min(1).max(100),
            windowMs: z.number().int().min(10_000).max(86_400_000),
          })
          .strict(),
        request.body,
      );
      const account = await updateAccountPublishingLimits(db.db, id, body);
      await appendAuditEvent(db.db, {
        actorType: 'operator',
        actorId: actor.id,
        action: 'account.limits_updated',
        resourceType: 'platform_account',
        resourceId: account.id,
        payload: body,
      });
      return reply.send(toSafeAccountView(account));
    },
  );

  // 人工处理完成后恢复账号状态；实际授权仍需再次检查。
  app.post(
    '/api/v1/xiaohongshu/accounts/:id/resolve-human',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = request.actor;
      if (actor === undefined || actor.kind !== 'operator') {
        return reply.code(403).send({ error: '仅运营人员可恢复账号' });
      }
      const { id } = request.params as { id: string };
      const account = await clearAccountHumanAttention(db.db, id, 'UNKNOWN');
      await appendAuditEvent(db.db, {
        actorType: 'operator',
        actorId: actor.id,
        action: 'account.human_attention_resolved',
        resourceType: 'platform_account',
        resourceId: account.id,
      });
      return reply.send(toSafeAccountView(account));
    },
  );

  // 授权健康检查（经适配器；未配置适配器时 503）
  app.post(
    '/api/v1/xiaohongshu/accounts/:id/check-auth',
    { preHandler: authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isOperator(request.actor)) {
        return reply.code(403).send({ error: '仅运营人员可检查账号授权' });
      }
      if (adapter === null || (adapter.sessionMode !== 'sidecar' && secrets === null)) {
        return reply
          .code(503)
          .send({ error: '发布适配器未配置（缺少 MCP 地址或绑定账号）' });
      }
      if (adapter.sessionMode === 'sidecar' && id !== env.XHS_MCP_ACCOUNT_ID) {
        return reply.code(409).send({ error: '该账号不是 MCP 容器当前绑定的账号' });
      }
      const account = await findAccount(db.db, id);
      if (account === null) {
        return reply.code(404).send({ error: `账号不存在：${id}` });
      }
      const secretValue =
        adapter.sessionMode === 'sidecar'
          ? ''
          : await secrets!.resolveSecret(account.secretRef);
      const result = await adapter.checkAuth({
        accountId: account.id,
        alias: account.alias,
        secretValue,
      });
      const health =
        result.healthy === 'HEALTHY'
          ? 'HEALTHY'
          : result.healthy === 'AUTH_REQUIRED'
            ? 'AUTH_REQUIRED'
            : 'CHALLENGE_REQUIRED';
      const updated = await updateAccountHealth(db.db, id, {
        health,
        note: result.message,
        needsHumanAttention: health !== 'HEALTHY',
      });
      await appendAuditEvent(db.db, {
        actorType: 'operator',
        actorId: request.actor?.id ?? 'operator',
        action: 'account.auth_checked',
        resourceType: 'platform_account',
        resourceId: updated.id,
        payload: { health: updated.health },
      });
      return reply.send(toSafeAccountView(updated));
    },
  );
}
