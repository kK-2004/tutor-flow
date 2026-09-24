import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenAI } from '@ai-sdk/openai';
import {
  extractJsonMiddleware,
  generateText,
  NoObjectGeneratedError,
  Output,
  wrapLanguageModel,
} from 'ai';

import { GatewayError, type LlmGateway } from './gateway-types.js';

export interface AiSdkLlmOptions {
  baseURL: string;
  model: string;
  apiKey: string;
  providerId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  apiMode?: 'chat' | 'responses';
}

/** 使用 Vercel AI SDK 接入兼容 OpenAI 的对话补全或 Responses 模型服务。 */
export function createAiSdkLlmGateway(options: AiSdkLlmOptions): LlmGateway {
  const chatProvider = createOpenAICompatible({
    name: 'custom-openai',
    baseURL: options.baseURL,
    apiKey: options.apiKey,
    fetch: options.fetchImpl,
  });
  const responsesProvider = createOpenAI({
    name: 'custom-openai-responses',
    baseURL: options.baseURL,
    apiKey: options.apiKey,
    fetch: options.fetchImpl,
  });

  return {
    async complete(request) {
      try {
        const baseModel =
          options.apiMode === 'responses'
            ? responsesProvider.responses(options.model)
            : chatProvider.chatModel(options.model);
        const result = await generateText({
          model: request.outputSchema
            ? wrapLanguageModel({ model: baseModel, middleware: extractJsonMiddleware() })
            : baseModel,
          system: request.systemPrompt,
          ...(request.images && request.images.length > 0
            ? {
                messages: [
                  {
                    role: 'user' as const,
                    content: [
                      { type: 'text' as const, text: request.userPrompt },
                      ...request.images.map((image) => ({
                        type: 'file' as const,
                        data: new URL(image.url),
                        mediaType: image.mediaType,
                        providerOptions: {
                          openai: { imageDetail: image.detail },
                        },
                      })),
                    ],
                  },
                ],
              }
            : { prompt: request.userPrompt }),
          maxOutputTokens: request.maxTokens,
          output: request.outputSchema
            ? Output.object({ schema: request.outputSchema, name: request.outputName })
            : undefined,
          ...(options.apiMode === 'responses' && options.model === 'deepseek-flash'
            ? {
                providerOptions: {
                  openai: { forceReasoning: true, reasoningEffort: 'none' },
                },
              }
            : {}),
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(options.timeoutMs ?? 90_000),
        });
        const outputText = request.outputSchema
          ? JSON.stringify(result.output)
          : result.text;
        if (outputText.trim() === '') {
          throw new GatewayError('模型返回了空内容', { retryable: true });
        }
        return {
          text: outputText,
          provider:
            options.providerId ??
            (options.apiMode === 'responses'
              ? 'custom-openai-responses'
              : 'custom-openai'),
          model: result.response.modelId || options.model,
          usage: {
            promptTokens: result.usage.inputTokens ?? 0,
            completionTokens: result.usage.outputTokens ?? 0,
          },
        };
      } catch (error) {
        if (error instanceof GatewayError) {
          throw error;
        }
        const status = (error as { statusCode?: number }).statusCode;
        const detail = NoObjectGeneratedError.isInstance(error)
          ? `结构化输出无法解析（finishReason=${error.finishReason ?? '未知'}，输出长度=${error.text?.length ?? 0}）`
          : error instanceof Error
            ? error.message.slice(0, 160)
            : '未知错误';
        throw new GatewayError(`模型请求失败：${detail}`, {
          retryable: status === undefined || status === 429 || status >= 500,
          status,
        });
      }
    },
  };
}
