import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createAiSdkLlmGateway } from './ai-sdk-llm.js';

describe('Vercel AI SDK 模型网关', () => {
  it('未设置输出上限时不向模型发送上限，默认超时为 300 秒', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            id: 'chatcmpl-unlimited',
            object: 'chat.completion',
            created: 1,
            model: 'custom-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '初稿正文' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    try {
      const gateway = createAiSdkLlmGateway({
        baseURL: 'https://model.example/v1',
        model: 'custom-model',
        apiKey: 'test-key',
        fetchImpl,
      });
      await gateway.complete({
        task: 'canonical_article',
        promptVersion: 'test@1',
        systemPrompt: '系统规则',
        userPrompt: '生成初稿',
      });

      const [, init] = fetchImpl.mock.calls[0] ?? [];
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).not.toHaveProperty('max_tokens');
      expect(body).not.toHaveProperty('max_completion_tokens');
      expect(timeoutSpy).toHaveBeenCalledWith(300_000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('空输出错误包含结束原因和 token 用量', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            id: 'chatcmpl-empty',
            object: 'chat.completion',
            created: 1,
            model: 'custom-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '' },
                finish_reason: 'length',
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 256, total_tokens: 356 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const gateway = createAiSdkLlmGateway({
      baseURL: 'https://model.example/v1',
      model: 'custom-model',
      apiKey: 'test-key',
      fetchImpl,
    });

    await expect(
      gateway.complete({
        task: 'canonical_article',
        promptVersion: 'test@1',
        systemPrompt: '系统规则',
        userPrompt: '生成初稿',
        maxTokens: 256,
      }),
    ).rejects.toThrow(
      '模型返回了空内容（finishReason=length，outputTokens=256，maxOutputTokens=256）',
    );
  });

  it('向自定义 OpenAI 兼容地址传递提示词并返回内容与用量', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: 1,
            model: 'custom-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '{"title":"标题"}' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const gateway = createAiSdkLlmGateway({
      baseURL: 'https://model.example/v1',
      model: 'custom-model',
      apiKey: 'test-key',
      fetchImpl,
    });

    const result = await gateway.complete({
      task: 'query_planning',
      promptVersion: 'test@1',
      systemPrompt: '系统规则',
      userPrompt: '用户主题',
      maxTokens: 256,
    });

    expect(result).toMatchObject({
      text: '{"title":"标题"}',
      model: 'custom-model',
      usage: { promptTokens: 12, completionTokens: 7 },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://model.example/v1/chat/completions');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer test-key');
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages).toEqual([
      { role: 'system', content: '系统规则' },
      { role: 'user', content: '用户主题' },
    ]);
  });

  it('通过 DeepSeek Responses API 提交事实抽取 JSON Schema', async () => {
    const claims = {
      claims: [
        { statement: '可核验事实', sources: ['https://example.com'], confidence: 0.9 },
      ],
    };
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            id: 'response-test',
            object: 'response',
            created_at: 1,
            status: 'completed',
            model: 'deepseek-flash',
            output: [
              {
                type: 'message',
                id: 'msg-test',
                status: 'completed',
                role: 'assistant',
                content: [
                  {
                    type: 'output_text',
                    text: `\`\`\`json\n${JSON.stringify(claims)}\n\`\`\``,
                    annotations: [],
                  },
                ],
              },
            ],
            usage: { input_tokens: 20, output_tokens: 15, total_tokens: 35 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const gateway = createAiSdkLlmGateway({
      baseURL: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      apiKey: 'test-key',
      apiMode: 'responses',
      fetchImpl,
    });
    const schema = z
      .object({
        claims: z.array(
          z
            .object({
              statement: z.string(),
              sources: z.array(z.string()),
              confidence: z.number(),
            })
            .strict(),
        ),
      })
      .strict();

    const result = await gateway.complete({
      task: 'claim_extraction',
      promptVersion: 'test@1',
      systemPrompt: '只提取事实',
      userPrompt: '资料正文',
      maxTokens: 2048,
      outputSchema: schema,
      outputName: 'extracted_claims',
    });

    expect(JSON.parse(result.text)).toEqual(claims);
    expect(result.usage).toEqual({ promptTokens: 20, completionTokens: 15 });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://api.deepseek.com/responses');
    const body = JSON.parse(String(init?.body)) as {
      text: { format: { type: string; name: string; schema: Record<string, unknown> } };
      reasoning?: { effort: string };
    };
    expect(body.text.format.type).toBe('json_schema');
    expect(body.text.format.name).toBe('extracted_claims');
    expect(body.text.format.schema).toMatchObject({
      type: 'object',
      required: ['claims'],
    });
    expect(JSON.stringify(body.text.format.schema)).not.toContain('minLength');
    expect(body.reasoning?.effort).toBe('none');
  });

  it('对话补全模式要求 JSON，并将无法解析的事实输出标记为可重试错误', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            id: 'chatcmpl-invalid',
            object: 'chat.completion',
            created: 1,
            model: 'custom-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '{"claims":[' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const gateway = createAiSdkLlmGateway({
      baseURL: 'https://model.example/v1',
      model: 'custom-model',
      apiKey: 'test-key',
      fetchImpl,
    });
    await expect(
      gateway.complete({
        task: 'claim_extraction',
        promptVersion: 'test@1',
        systemPrompt: '只输出 JSON',
        userPrompt: '资料正文',
        maxTokens: 2048,
        outputSchema: z.object({ claims: z.array(z.string()) }),
        outputName: 'extracted_claims',
      }),
    ).rejects.toMatchObject({ retryable: true });
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as { response_format: { type: string } };
    expect(body.response_format.type).toBe('json_object');
  });
});
