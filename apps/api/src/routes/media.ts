/** 内容中心媒体路由：应用令牌只在服务端使用，文件字节通过预签名地址直传。 */
import { EnvSecretProvider, type ApiEnv } from '@tutor-flow/config/server';
import { getSetting, type DbClient } from '@tutor-flow/db';
import {
  DEFAULT_CONTENT_CENTER_SETTINGS,
  parseContentCenterSettings,
} from '@tutor-flow/domain';
import {
  ContentCenterError,
  createContentCenterClient,
  GatewayError,
  type LlmGateway,
} from '@tutor-flow/integrations';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { isOperator, requireAuthenticated } from '../lib/auth.js';
import { parseBody } from '../lib/http.js';

const imageTypes = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

export function registerMediaRoutes(
  app: FastifyInstance,
  options: { db: DbClient; env: ApiEnv; llm: LlmGateway },
): void {
  const { db, env, llm } = options;
  const authenticate = requireAuthenticated(env, db);
  const secrets = new EnvSecretProvider();

  const settings = async () => {
    const item = await getSetting(db.db, 'content_center');
    return item === null
      ? DEFAULT_CONTENT_CENTER_SETTINGS
      : parseContentCenterSettings(item.value);
  };

  const client = async () => {
    if (env.CONTENT_CENTER_URL === undefined) return null;
    const token = await secrets.resolveSecret(env.CONTENT_CENTER_TOKEN_REF);
    return createContentCenterClient({
      baseUrl: env.CONTENT_CENTER_URL,
      appToken: token,
    });
  };

  app.post(
    '/api/v1/media/uploads/init',
    { preHandler: authenticate },
    async (request, reply) => {
      if (!isOperator(request.actor)) {
        return reply.code(403).send({ error: '仅运营人员可上传媒体' });
      }
      const input = parseBody(
        z
          .object({
            filename: z.string().min(1).max(200),
            size: z.number().int().positive(),
            contentType: z.string(),
          })
          .strict(),
        request.body,
      );
      const config = await settings();
      if (input.size > config.maxUploadBytes) {
        return reply.code(413).send({ error: '图片超过后台设置的上传大小限制' });
      }
      const extension = imageTypes.get(input.contentType);
      if (extension === undefined) {
        return reply.code(400).send({ error: '仅支持 JPEG、PNG、WebP 图片' });
      }
      const filename = input.filename.split(/[\\/]/).at(-1) ?? '';
      if (filename === '' || !/^[^?#]+\.(jpe?g|png|webp)$/i.test(filename)) {
        return reply.code(400).send({ error: '图片文件名或扩展名无效' });
      }
      const actualExtension = filename.split('.').at(-1)?.toLowerCase();
      if (
        actualExtension !== extension &&
        !(extension === 'jpg' && actualExtension === 'jpeg')
      ) {
        return reply.code(400).send({ error: '图片扩展名与内容类型不一致' });
      }
      const api = await client();
      if (api === null) return reply.code(503).send({ error: '内容中心未配置' });
      try {
        return reply.send(
          await api.initUpload(filename, {
            size: input.size,
            contentType: input.contentType,
            path: '',
          }),
        );
      } catch (error) {
        if (error instanceof ContentCenterError) {
          return reply.code(502).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.post(
    '/api/v1/media/uploads/complete',
    { preHandler: authenticate },
    async (request, reply) => {
      if (!isOperator(request.actor)) {
        return reply.code(403).send({ error: '仅运营人员可确认媒体上传' });
      }
      const input = parseBody(
        z
          .object({
            storageKey: z.string().min(1).max(1024),
            source: z
              .string()
              .min(1)
              .max(50)
              .regex(/^[A-Za-z0-9_-]+$/),
          })
          .strict(),
        request.body,
      );
      const api = await client();
      if (api === null) return reply.code(503).send({ error: '内容中心未配置' });
      try {
        const result = await api.completeUpload(input.storageKey, input.source);
        if (!imageTypes.has(result.contentType)) {
          return reply.code(422).send({ error: '内容中心返回的文件不是受支持的图片' });
        }
        const config = await settings();
        if (result.size > config.maxUploadBytes) {
          return reply.code(413).send({ error: '实际图片大小超过后台设置的限制' });
        }
        return reply.send({
          fileId: result.fileId,
          name: result.name,
          size: result.size,
          contentType: result.contentType,
          media: {
            fileId: result.fileId,
            name: result.name,
            contentType: result.contentType,
          },
        });
      } catch (error) {
        if (error instanceof ContentCenterError) {
          return reply.code(502).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.get(
    '/api/v1/media/:fileId/cdn-link',
    { preHandler: authenticate },
    async (request, reply) => {
      if (!isOperator(request.actor)) {
        return reply.code(403).send({ error: '仅运营人员可查看媒体链接' });
      }
      const parsed = z.coerce
        .number()
        .int()
        .positive()
        .safeParse((request.params as { fileId: string }).fileId);
      if (!parsed.success) return reply.code(400).send({ error: '文件 ID 无效' });
      const api = await client();
      if (api === null) return reply.code(503).send({ error: '内容中心未配置' });
      const config = await settings();
      try {
        const link = await api.getDownloadLink(parsed.data, config.downloadExpiresIn);
        return reply.send({ ...link, url: await api.resolveFinalUrl(link.url) });
      } catch (error) {
        if (error instanceof ContentCenterError) {
          return reply.code(502).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.post(
    '/api/v1/research-library/images/extract-text',
    { preHandler: authenticate },
    async (request, reply) => {
      if (!isOperator(request.actor)) {
        return reply.code(403).send({ error: '仅运营人员可提取图片文字' });
      }
      const input = parseBody(
        z.object({ fileId: z.number().int().positive() }).strict(),
        request.body,
      );
      const api = await client();
      if (api === null) return reply.code(503).send({ error: '内容中心未配置' });
      try {
        const config = await settings();
        const [image, download] = await Promise.all([
          api.getCdnLink(input.fileId, config.cdnExpiresIn),
          api.getDownloadLink(input.fileId, config.downloadExpiresIn),
        ]);
        const directUrl = await api.resolveFinalUrl(download.url);
        const result = await llm.complete({
          task: 'image_text_extraction',
          promptVersion: 'image-text-extraction@1',
          systemPrompt: [
            '你是图片文字提取助手。',
            '准确提取图片中可见的文字，保持原有阅读顺序和自然分段。',
            '只返回提取出的文字，不要描述图片，不要添加解释或 Markdown 围栏。',
          ].join('\n'),
          userPrompt: '请提取这张图片中的全部可见文字。',
          images: [
            {
              url: directUrl,
              mediaType: image.contentType,
              detail: 'low',
            },
          ],
          maxTokens: 4096,
        });
        return reply.send({ text: result.text.trim() });
      } catch (error) {
        if (error instanceof ContentCenterError || error instanceof GatewayError) {
          return reply.code(502).send({ error: error.message });
        }
        return reply.code(400).send({
          error: error instanceof Error ? error.message : '图片文字提取失败',
        });
      }
    },
  );

  app.get(
    '/api/v1/media/:fileId/download-link',
    { preHandler: authenticate },
    async (request, reply) => {
      if (!isOperator(request.actor)) {
        return reply.code(403).send({ error: '仅运营人员可获取下载链接' });
      }
      const parsed = z.coerce
        .number()
        .int()
        .positive()
        .safeParse((request.params as { fileId: string }).fileId);
      if (!parsed.success) return reply.code(400).send({ error: '文件 ID 无效' });
      const api = await client();
      if (api === null) return reply.code(503).send({ error: '内容中心未配置' });
      const config = await settings();
      try {
        return reply.send(
          await api.getDownloadLink(parsed.data, config.downloadExpiresIn),
        );
      } catch (error) {
        if (error instanceof ContentCenterError) {
          return reply.code(502).send({ error: error.message });
        }
        throw error;
      }
    },
  );
}
