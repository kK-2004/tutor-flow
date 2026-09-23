/**
 * 安全脱敏序列化工具。
 *
 * 任何要写入日志、审计载荷或返回客户端的对象都必须先经过 redactDeep：
 * 敏感键（secret/cookie/token/password 等）一律替换为占位符。
 */

/** 敏感键名匹配（不区分大小写与常见分隔符） */
const SENSITIVE_KEY_PATTERN =
  /secret|cookie|token|password|passwd|authorization|credential|api[_-]?key|session[_-]?id/i;

/** 脱敏占位符 */
export const REDACTED = '[REDACTED]' as const;

/** 最大递归深度（防御循环引用与超大对象） */
const MAX_DEPTH = 8;

/** 深度脱敏：返回新对象，不修改原值 */
export function redactDeep<T>(value: T, depth = 0): unknown {
  if (depth > MAX_DEPTH) {
    return '[TRUNCATED]';
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, depth + 1));
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? REDACTED
        : redactDeep(item, depth + 1);
    }
    return output;
  }
  // 函数、symbol 等不可序列化值一律丢弃
  return undefined;
}

/** 脱敏后序列化为 JSON 字符串（用于日志与 jsonb 载荷） */
export function redactToJson(value: unknown): string {
  return JSON.stringify(redactDeep(value));
}
