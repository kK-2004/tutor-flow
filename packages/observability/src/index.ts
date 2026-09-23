/**
 * 轻量观测抽象。
 *
 * 首期不绑定具体厂商，服务进程可以把同一套 trace、结构化日志和指标
 * 接到 OpenTelemetry Collector、Prometheus 或现有日志平台。
 */
import { randomUUID } from 'node:crypto';

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

export interface Span {
  context: TraceContext;
  setAttribute(name: string, value: string | number | boolean): void;
  end(error?: unknown): void;
}

export interface StructuredLogger {
  child(fields: Record<string, string | number | boolean | undefined>): StructuredLogger;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface MetricsSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<string, { count: number; sum: number; max: number }>;
}

export interface MetricsRegistry {
  increment(name: string, value?: number): void;
  set(name: string, value: number): void;
  observe(name: string, value: number): void;
  snapshot(): MetricsSnapshot;
}

/** 脱敏结构化日志，正文、Cookie、密钥和授权头不会被输出。 */
export function createLogger(
  base: Record<string, string | number | boolean | undefined> = {},
): StructuredLogger {
  const write = (
    level: string,
    message: string,
    fields: Record<string, unknown> = {},
  ) => {
    const safe = redact(fields);
    process.stdout.write(
      `${JSON.stringify({ level, time: new Date().toISOString(), message, ...base, ...safe })}\n`,
    );
  };
  return {
    child(fields) {
      return createLogger({ ...base, ...fields });
    },
    info(message, fields) {
      write('info', message, fields);
    },
    warn(message, fields) {
      write('warn', message, fields);
    },
    error(message, fields) {
      write('error', message, fields);
    },
  };
}

/** 创建本进程指标注册表，指标名和标签由调用方保持稳定。 */
export function createMetrics(): MetricsRegistry {
  const counters = new Map<string, number>();
  const gauges = new Map<string, number>();
  const histograms = new Map<string, { count: number; sum: number; max: number }>();
  return {
    increment(name, value = 1) {
      counters.set(name, (counters.get(name) ?? 0) + value);
    },
    set(name, value) {
      gauges.set(name, value);
    },
    observe(name, value) {
      const existing = histograms.get(name) ?? { count: 0, sum: 0, max: 0 };
      histograms.set(name, {
        count: existing.count + 1,
        sum: existing.sum + value,
        max: Math.max(existing.max, value),
      });
    },
    snapshot() {
      return {
        counters: Object.fromEntries(counters),
        gauges: Object.fromEntries(gauges),
        histograms: Object.fromEntries(histograms),
      };
    },
  };
}

/** 创建一个内存 span，并自动生成可在日志与指标中关联的 id。 */
export function startSpan(
  name: string,
  parent?: TraceContext,
  attributes: Record<string, string | number | boolean> = {},
): Span {
  const context: TraceContext = {
    traceId: parent?.traceId ?? randomUUID(),
    spanId: randomUUID(),
    ...(parent === undefined ? {} : { parentSpanId: parent.spanId }),
  };
  const values = new Map<string, string | number | boolean>(Object.entries(attributes));
  return {
    context,
    setAttribute(key, value) {
      values.set(key, value);
    },
    end(error) {
      void name;
      void error;
      void values;
    },
  };
}

function redact(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/cookie|secret|token|authorization|password|prompt|body|content/i.test(key)) {
      result[key] = '[REDACTED]';
    } else if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      result[key] = redact(item as Record<string, unknown>);
    } else {
      result[key] = item;
    }
  }
  return result;
}
