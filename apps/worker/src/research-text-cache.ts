/**
 * 研究正文临时缓存（进程内，TTL 有界）。
 *
 * 用户决策：网页正文不持久化（不落数据库、不落对象存储）。
 * 研究链路的多个步骤（去重、评分、事实抽取）需要正文，
 * 这里以进程内存 + 短 TTL 提供即时传递；缓存缺失时由各步骤
 * 重新抓取（抓取器幂等）。缓存条目用完自动过期，进程退出即消失。
 */

/** 缓存条目 */
interface CacheEntry {
  text: string;
  expiresAt: number;
}

/** 默认 TTL：30 分钟（跨步骤足够，研究完成后自然过期） */
const DEFAULT_TTL_MS = 30 * 60 * 1000;

/** 默认容量上限（防止内存无界增长） */
const DEFAULT_MAX_ENTRIES = 200;

export interface ResearchTextCache {
  get(runId: string, sourceId: string): Promise<string | null>;
  set(runId: string, sourceId: string, text: string): Promise<void>;
  /** 清除某次运行的全部缓存正文（研究完成后调用） */
  clearRun(runId: string): Promise<void>;
}

export interface InMemoryTextCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
}

/** 创建进程内正文缓存 */
export function createInMemoryTextCache(
  options: InMemoryTextCacheOptions = {},
): ResearchTextCache {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const entries = new Map<string, CacheEntry>();

  const keyOf = (runId: string, sourceId: string): string => `${runId}:${sourceId}`;

  return {
    async get(runId, sourceId): Promise<string | null> {
      const entry = entries.get(keyOf(runId, sourceId));
      if (entry === undefined) {
        return null;
      }
      if (entry.expiresAt < Date.now()) {
        entries.delete(keyOf(runId, sourceId));
        return null;
      }
      return entry.text;
    },
    async set(runId, sourceId, text): Promise<void> {
      // 容量上限：优先淘汰已过期项，其次最旧项
      if (entries.size >= maxEntries) {
        const oldest = [...entries.entries()].sort(
          (a, b) => a[1].expiresAt - b[1].expiresAt,
        );
        const toEvict = Math.max(1, Math.floor(maxEntries * 0.1));
        for (const [key] of oldest.slice(0, toEvict)) {
          entries.delete(key);
        }
      }
      entries.set(keyOf(runId, sourceId), { text, expiresAt: Date.now() + ttlMs });
    },
    async clearRun(runId): Promise<void> {
      const prefix = `${runId}:`;
      for (const key of entries.keys()) {
        if (key.startsWith(prefix)) {
          entries.delete(key);
        }
      }
    },
  };
}
