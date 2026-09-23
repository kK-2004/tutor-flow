import { describe, expect, it } from 'vitest';

import {
  checkPublisherAdapterContract,
  FakePublisherAdapter,
  PublisherError,
} from '@tutor-flow/integrations';

/** 发布适配器契约测试：冒烟探针不得产生真实发布副作用。 */
describe('Publisher Adapter 契约', () => {
  it('模拟适配器通过授权、校验和预览契约', async () => {
    const adapter = new FakePublisherAdapter();
    const result = await checkPublisherAdapterContract(adapter, {
      accountId: 'account-test',
      alias: '测试账号',
      secretValue: '仅测试内存凭据',
    });
    expect(result.valid).toBe(true);
    expect(adapter.publishedCalls).toHaveLength(0);
  });

  it('未知结果错误携带副作用疑似标记', async () => {
    const adapter = new FakePublisherAdapter();
    adapter.mode = 'lost_response';
    await expect(
      adapter.publish(
        { accountId: 'account-test', alias: '测试账号', secretValue: '内存' },
        {
          title: '契约测试标题',
          body: '契约测试正文足够长，确保校验输入完整。',
          tags: ['契约'],
          mediaObjectKeys: ['media/cover.png'],
          aigcDisclosed: true,
        },
      ),
    ).rejects.toMatchObject<Partial<PublisherError>>({
      code: 'UNKNOWN_OUTCOME',
      sideEffectSuspected: true,
    });
  });
});
