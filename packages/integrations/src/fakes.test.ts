import { describe, expect, it } from 'vitest';

import {
  FakeContentExtractor,
  FakeLlmGateway,
  FakeObjectStorage,
  FakePageFetcher,
  FakeSearchGateway,
  FakeVectorService,
} from './fakes.js';

/**
 * 模拟实现冒烟测试：确定性、可注入故障。
 */
describe('FakeSearchGateway', () => {
  it('按脚本匹配返回结果并可注入失败', async () => {
    const gateway = new FakeSearchGateway();
    gateway.on((q) => q.intent === 'fail', new Error('供应商不可用'));
    gateway.on(
      (q) => q.intent === 'ok',
      [{ title: '结果', url: 'https://example.com/a', snippet: '片段' }],
    );

    await expect(
      gateway.search({ query: 'q', language: 'zh', intent: 'fail', maxResults: 5 }),
    ).rejects.toThrow('供应商不可用');
    const results = await gateway.search({
      query: 'q',
      language: 'zh',
      intent: 'ok',
      maxResults: 5,
    });
    expect(results).toHaveLength(1);
    expect(gateway.calls).toHaveLength(2);
  });
});

describe('FakePageFetcher + FakeContentExtractor', () => {
  it('抓取并提取正文', async () => {
    const fetcher = new FakePageFetcher();
    fetcher.on('https://example.com/a', {
      finalUrl: 'https://example.com/final',
      body: '<html><head><title>标题</title></head><body><script>x</script><p>正文内容</p></body></html>',
    });
    const page = await fetcher.fetch('https://example.com/a');
    const extractor = new FakeContentExtractor();
    const content = extractor.extract(page);
    expect(content.canonicalUrl).toBe('https://example.com/final');
    expect(content.title).toBe('标题');
    expect(content.text).toContain('正文内容');
    expect(content.text).not.toContain('script');
  });
});

describe('FakeVectorService', () => {
  it('相似文本相似度高，无关文本低', async () => {
    const vectors = new FakeVectorService();
    const a = await vectors.embed('PostgreSQL 17 发布了新的性能优化');
    const b = await vectors.embed('PostgreSQL 17 发布性能优化详情');
    const c = await vectors.embed('今天天气很好适合出门散步');
    expect(vectors.similarity(a, b)).toBeGreaterThan(vectors.similarity(a, c));
  });
});

describe('FakeLlmGateway + FakeObjectStorage', () => {
  it('按任务脚本响应并记录调用', async () => {
    const llm = new FakeLlmGateway();
    llm.on(
      (r) => r.task === 'query_planning',
      () => '规划结果',
    );
    const response = await llm.complete({
      task: 'query_planning',
      promptVersion: 'v1',
      systemPrompt: '系统提示词',
      userPrompt: '用户提示词',
      maxTokens: 100,
    });
    expect(response.text).toBe('规划结果');
    expect(response.model).toBe('fake-model-1');
    expect(llm.calls).toHaveLength(1);
  });

  it('对象存储写入后可读取与判断存在性', async () => {
    const storage = new FakeObjectStorage();
    await storage.putObject('research/run1/page.html', Buffer.from('内容'), 'text/html');
    await expect(storage.hasObject('research/run1/page.html')).resolves.toBe(true);
    await expect(storage.getObject('research/run1/page.html')).resolves.toEqual(
      Buffer.from('内容'),
    );
    await expect(storage.hasObject('missing')).resolves.toBe(false);
  });
});
