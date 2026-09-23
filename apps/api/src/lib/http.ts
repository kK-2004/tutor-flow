/**
 * HTTP 错误映射与请求校验辅助。
 */
import { XhsSessionError } from '@tutor-flow/integrations';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, type ZodType } from 'zod';

import {
  IdempotencyConflictError,
  NotFoundError,
  OptimisticLockError,
  RevisionConflictError,
  StateGuardError,
} from '@tutor-flow/db';

/** 请求载荷校验失败（400） */
export class RequestValidationError extends Error {
  readonly details: unknown;

  constructor(details: unknown) {
    super('请求参数校验失败');
    this.name = 'RequestValidationError';
    this.details = details;
  }
}

/** 用 zod schema 校验请求体 */
export function parseBody<T>(schema: ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new RequestValidationError(result.error.issues);
  }
  return result.data;
}

/** 统一错误映射：注册到 fastify.setErrorHandler */
export function mapHttpError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (error instanceof XhsSessionError) {
    request.log.warn({ code: error.code }, '小红书登录上游调用失败');
    void reply.code(error.code === 'XHS_TIMEOUT' ? 504 : 502).send({
      error: error.message,
      code: error.code,
    });
    return;
  }
  if (error instanceof RequestValidationError || error instanceof ZodError) {
    void reply.code(400).send({ error: '请求参数校验失败' });
    return;
  }
  if (error instanceof NotFoundError) {
    void reply.code(404).send({ error: error.message });
    return;
  }
  if (
    error instanceof IdempotencyConflictError ||
    error instanceof OptimisticLockError ||
    error instanceof RevisionConflictError ||
    error instanceof StateGuardError
  ) {
    void reply.code(409).send({ error: error.message });
    return;
  }
  // 未知错误：记录日志但不泄露内部信息
  request.log.error(error, '未处理的服务器错误');
  void reply.code(500).send({ error: '服务器内部错误' });
}
