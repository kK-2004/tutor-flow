import { describe, expect, it } from 'vitest';

import type { DbClient } from '@tutor-flow/db';
import type { LlmGateway, SearchGateway } from '@tutor-flow/integrations';
import { createBusinessHandlers } from '../../apps/worker/src/business-handlers.js';

describe('Worker 业务步骤注册', () => {
  it('注册从查询规划到草稿创建的全部步骤', () => {
    const handlers = createBusinessHandlers({
      db: {} as DbClient,
      llm: {} as LlmGateway,
      search: {} as SearchGateway,
    });
    expect(Object.keys(handlers).sort()).toEqual(
      [
        'QUERY_PLANNING',
        'SEARCH',
        'FETCH_SOURCES',
        'DEDUPE_SOURCES',
        'SCORE_SOURCES',
        'EXTRACT_CLAIMS',
        'GENERATE_DIRECTIONS',
        'GENERATE_CANONICAL',
        'ADAPT_XIAOHONGSHU',
        'MODERATE_CONTENT',
        'CREATE_DRAFT',
      ].sort(),
    );
  });
});
