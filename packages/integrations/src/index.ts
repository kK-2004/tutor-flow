/**
 * 外部集成共享包入口。
 *
 * 接口契约供领域与 Worker 依赖；Brave/真实抓取/真实 LLM 适配器
 * 在任务 4.3、4.4 等具体任务中补齐。
 */
export * from './gateway-types.js';
export * from './url.js';
export * from './brave-search.js';
export * from './safe-fetcher.js';
export * from './html-extractor.js';
export * from './prompt-isolation.js';
export * from './publisher.js';
export * from './xhs-mcp.js';
export * from './content-center.js';
export * from './fakes.js';
