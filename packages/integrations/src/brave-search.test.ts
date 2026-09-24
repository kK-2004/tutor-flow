import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBraveSearchGateway } from './brave-search.js';

describe('Brave Search 网关', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('将相邻请求的发起时间限制为至少间隔一秒', async () => {
    vi.useFakeTimers();
    const requestTimes: number[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      requestTimes.push(Date.now());
      return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
    });
    const gateway = createBraveSearchGateway({
      apiKey: 'test-key',
      fetchImpl,
    });
    const query = {
      query: '测试查询',
      language: 'zh',
      intent: 'BASIC_UNDERSTANDING',
      maxResults: 5,
    };

    const searches = [
      gateway.search(query),
      gateway.search(query),
      gateway.search(query),
    ];
    await vi.runAllTimersAsync();
    await Promise.all(searches);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(requestTimes[1]! - requestTimes[0]!).toBeGreaterThanOrEqual(1_000);
    expect(requestTimes[2]! - requestTimes[1]!).toBeGreaterThanOrEqual(1_000);
  });
});
