/**
 * 账号级发布通道（任务 6.6）。
 *
 * - 串行：同一账号同时只执行一个发布（队列排队）；
 * - 令牌桶：滚动窗口内发布次数受限，超出部分延迟到窗口滑出；
 * - 有界抖动：每次发布前追加随机延迟，避免整点突发；
 * - 熔断器：连续选择器失效达到阈值时打开，冷却期内拒绝发布。
 *
 * 首期单 Publisher Worker 进程，进程内通道即可满足账号级串行；
 * 多实例部署时按账号分片调度（领域语义不变）。
 */
import type { MetricsRegistry } from '@tutor-flow/observability';

/** 通道配置（来源：platform_account 的限流字段 + 策略） */
export interface LaneConfig {
  /** 账号级并发（首期固定 1） */
  concurrency: number;
  /** 滚动窗口内最大发布次数 */
  tokensPerWindow: number;
  /** 窗口长度（毫秒） */
  windowMs: number;
  /** 发布前抖动上限（毫秒），实际取随机 [0, jitterMs) */
  jitterMs: number;
}

export const DEFAULT_LANE_CONFIG: LaneConfig = {
  concurrency: 1,
  tokensPerWindow: 4,
  windowMs: 3_600_000,
  jitterMs: 30_000,
};

/** 熔断器配置 */
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 30 * 60 * 1000;

/** 熔断器状态 */
export interface BreakerState {
  open: boolean;
  /** 打开时间（冷却期内拒绝） */
  openedAt: number | null;
  /** 连续选择器失效次数 */
  consecutiveSelectorFailures: number;
}

export interface PublishLane {
  /** 串行 + 限流 + 抖动后执行；返回执行结果 */
  run(accountId: string, config: LaneConfig, task: () => Promise<void>): Promise<void>;
  /** 记录一次成功（清零熔断计数） */
  recordSuccess(accountId: string): void;
  /** 记录一次选择器失效（达到阈值打开熔断） */
  recordSelectorFailure(accountId: string): void;
  /** 熔断器是否打开（打开且未过冷却期） */
  isBreakerOpen(accountId: string): boolean;
  /** 人工修复后手动关闭熔断器 */
  resetBreaker(accountId: string): void;
  /** 等待全部排空（测试用） */
  drain(): Promise<void>;
}

export function createPublishLanes(
  options: { jitterRandom?: () => number; metrics?: MetricsRegistry } = {},
): PublishLane {
  const random = options.jitterRandom ?? Math.random;
  type PendingTask = {
    config: LaneConfig;
    task: () => Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
    enqueuedAt: number;
  };
  const queues = new Map<string, PendingTask[]>();
  const active = new Map<string, number>();
  const running = new Set<Promise<void>>();
  /** 令牌桶：账号 → 窗口内发布时间戳列表 */
  const windowStamps = new Map<string, number[]>();
  const breakers = new Map<string, BreakerState>();
  const metrics = options.metrics;

  const breakerOf = (accountId: string): BreakerState => {
    const existing = breakers.get(accountId);
    if (existing !== undefined) {
      return existing;
    }
    const initial: BreakerState = {
      open: false,
      openedAt: null,
      consecutiveSelectorFailures: 0,
    };
    breakers.set(accountId, initial);
    return initial;
  };

  const lane = (): PublishLane => {
    const pump = (accountId: string): void => {
      const pending = queues.get(accountId) ?? [];
      const config = pending[0]?.config;
      const limit = Math.max(config?.concurrency ?? 1, 1);
      while ((active.get(accountId) ?? 0) < limit && pending.length > 0) {
        const item = pending.shift();
        if (item === undefined) break;
        if (laneApi.isBreakerOpen(accountId)) {
          item.reject(new Error(`账号 ${accountId} 发布熔断器打开，冷却期内禁止发布`));
          continue;
        }
        active.set(accountId, (active.get(accountId) ?? 0) + 1);
        const execution = (async () => {
          try {
            metrics?.observe('publisher_queue_wait_ms', Date.now() - item.enqueuedAt);
            // 令牌桶：窗口内配额用尽则等待到最早一个时间戳滑出窗口。
            const stamps = windowStamps.get(accountId) ?? [];
            const now = Date.now();
            const recent = stamps.filter((stamp) => now - stamp < item.config.windowMs);
            if (recent.length >= item.config.tokensPerWindow) {
              const earliest = Math.min(...recent);
              const waitMs = item.config.windowMs - (now - earliest) + 1;
              await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
            }
            // 有界抖动避免同一时刻突发请求。
            const jitter = Math.floor(random() * Math.max(item.config.jitterMs, 1));
            if (jitter > 0)
              await new Promise<void>((resolve) => setTimeout(resolve, jitter));
            const stampsNow = windowStamps.get(accountId) ?? [];
            const kept = stampsNow.filter(
              (stamp) => Date.now() - stamp < item.config.windowMs,
            );
            kept.push(Date.now());
            windowStamps.set(accountId, kept);
            await item.task();
            item.resolve();
          } catch (error) {
            item.reject(error);
          } finally {
            active.set(accountId, Math.max((active.get(accountId) ?? 1) - 1, 0));
            if (
              (queues.get(accountId)?.length ?? 0) === 0 &&
              (active.get(accountId) ?? 0) === 0
            ) {
              queues.delete(accountId);
              active.delete(accountId);
            } else {
              pump(accountId);
            }
          }
        })();
        const tracked = execution.then(
          () => undefined,
          () => undefined,
        );
        running.add(tracked);
        void tracked.then(() => running.delete(tracked));
      }
      if (pending.length === 0 && (active.get(accountId) ?? 0) === 0) {
        queues.delete(accountId);
      }
    };

    const laneApi: PublishLane = {
      async run(accountId, config, task) {
        if (laneApi.isBreakerOpen(accountId)) {
          throw new Error(`账号 ${accountId} 发布熔断器打开，冷却期内禁止发布`);
        }
        await new Promise<void>((resolve, reject) => {
          const pending = queues.get(accountId) ?? [];
          pending.push({ config, task, resolve, reject, enqueuedAt: Date.now() });
          queues.set(accountId, pending);
          pump(accountId);
        });
      },

      recordSuccess(accountId) {
        const breaker = breakerOf(accountId);
        breaker.consecutiveSelectorFailures = 0;
        if (breaker.open) {
          breaker.open = false;
          breaker.openedAt = null;
          metrics?.set(
            'publisher_breaker_open_accounts',
            [...breakers.values()].filter((item) => item.open).length,
          );
        }
      },

      recordSelectorFailure(accountId) {
        const breaker = breakerOf(accountId);
        breaker.consecutiveSelectorFailures += 1;
        if (breaker.consecutiveSelectorFailures >= BREAKER_THRESHOLD) {
          breaker.open = true;
          breaker.openedAt = Date.now();
          metrics?.set(
            'publisher_breaker_open_accounts',
            [...breakers.values()].filter((item) => item.open).length,
          );
        }
      },

      isBreakerOpen(accountId) {
        const breaker = breakerOf(accountId);
        if (!breaker.open) {
          return false;
        }
        if (
          breaker.openedAt !== null &&
          Date.now() - breaker.openedAt >= BREAKER_COOLDOWN_MS
        ) {
          // 冷却期结束：半开（允许一次尝试），失败会再次打开
          breaker.open = false;
          breaker.openedAt = null;
          breaker.consecutiveSelectorFailures = 0;
          metrics?.set(
            'publisher_breaker_open_accounts',
            [...breakers.values()].filter((item) => item.open).length,
          );
          return false;
        }
        return true;
      },

      resetBreaker(accountId) {
        breakers.set(accountId, {
          open: false,
          openedAt: null,
          consecutiveSelectorFailures: 0,
        });
        metrics?.set(
          'publisher_breaker_open_accounts',
          [...breakers.values()].filter((item) => item.open).length,
        );
      },

      async drain() {
        while (running.size > 0) {
          await Promise.allSettled([...running]);
        }
      },
    };
    return laneApi;
  };

  return lane();
}
