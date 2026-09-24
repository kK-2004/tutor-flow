import type { DbClient } from '@tutor-flow/db';
import type { StepType } from '@tutor-flow/domain';
import {
  createHtmlContentExtractor,
  createLocalVectorService,
  createSafePageFetcher,
  type LlmGateway,
  type SearchGateway,
} from '@tutor-flow/integrations';
import type { StepHandler } from '@tutor-flow/workflow';

import { createInMemoryTextCache } from './research-text-cache.js';
import { createResearchHandlers } from './steps/research.js';
import {
  createAdaptXiaohongshuHandler,
  createCreateDraftHandler,
  createGenerateCanonicalHandler,
  createModerateContentHandler,
} from './steps/content.js';

/** 集中注册完整的检索与内容生产链路，避免运行时遗漏步骤。 */
export function createBusinessHandlers(deps: {
  db: DbClient;
  llm: LlmGateway;
  search: SearchGateway;
}): Partial<Record<StepType, StepHandler>> {
  const { db, llm, search } = deps;
  const textCache = createInMemoryTextCache();
  return {
    ...createResearchHandlers({
      db,
      llm,
      search,
      fetcher: createSafePageFetcher(),
      extractor: createHtmlContentExtractor(),
      vector: createLocalVectorService(),
      textCache,
    }),
    GENERATE_CANONICAL: createGenerateCanonicalHandler({ db, llm, textCache }),
    ADAPT_XIAOHONGSHU: createAdaptXiaohongshuHandler({ db, llm, textCache }),
    MODERATE_CONTENT: createModerateContentHandler({ db }),
    CREATE_DRAFT: createCreateDraftHandler({ db }),
  };
}
