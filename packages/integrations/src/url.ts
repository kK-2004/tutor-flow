/**
 * URL 归一化与哈希：来源去重的基础。
 *
 * 归一化规则：
 * - 仅接受 http/https；
 * - 主机名转小写，去掉默认端口；
 * - 丢弃片段（#...）与常见追踪参数（utm_* 等）；
 * - 查询参数按名称排序；去掉路径末尾多余斜杠。
 */

/** 需要剔除的追踪参数前缀/名称 */
const TRACKING_PARAM_PATTERN = /^(utm_|fbclid$|gclid$|ref$|ref_src$|ref_url$|spm$)/i;

/** 归一化 URL；非法或非 http(s) 时返回 null */
export function normalizeUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  parsed.hostname = parsed.hostname.toLowerCase();
  if (
    (parsed.protocol === 'https:' && parsed.port === '443') ||
    (parsed.protocol === 'http:' && parsed.port === '80')
  ) {
    parsed.port = '';
  }
  parsed.hash = '';
  const params = [...parsed.searchParams.entries()].filter(
    ([name]) => !TRACKING_PARAM_PATTERN.test(name),
  );
  params.sort(([a], [b]) => a.localeCompare(b));
  parsed.search = '';
  for (const [name, value] of params) {
    parsed.searchParams.append(name, value);
  }
  // 去掉路径末尾斜杠（根路径除外）
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  }
  return parsed.toString();
}
