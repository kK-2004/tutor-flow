/**
 * 服务端富文本清洗（最终信任边界）。
 *
 * 草稿正文以 Markdown/纯文本为主，但为防御富编辑器引入的
 * 恶意标记，保存前统一执行：脚本/样式整块移除、事件处理器
 * 属性移除、javascript: 等危险 URL 移除、控制字符剔除。
 */

/** 危险标签整块移除 */
const DANGEROUS_BLOCKS =
  /<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<iframe[\s\S]*?<\/iframe>|<object[\s\S]*?<\/object>|<embed[\s\S]*?<\/embed>|<svg[\s\S]*?<\/svg>/gi;

/** 事件处理器属性（on*="..." / on*='...' / on*=bare） */
const EVENT_ATTRIBUTES = /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

/** 危险 URL 协议 */
const DANGEROUS_URL =
  /(href|src)\s*=\s*(?:"\s*(?:javascript|vbscript|data):[^"]*"|'\s*(?:javascript|vbscript|data):[^']*'|(?:javascript|vbscript|data):[^\s>]*)/gi;

/** 富文本允许的最小标签集合，避免把编辑器输出当作任意 HTML 信任。 */
const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'h1',
  'h2',
  'h3',
  'ul',
  'ol',
  'li',
  'blockquote',
  'a',
]);
const HTML_TAG = /<\/?([a-z][a-z0-9-]*)(?:\s[^>]*)?>/gi;

/** 控制字符（保留换行与制表） */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** 清洗富文本正文 */
export function sanitizeRichText(input: string): string {
  return input
    .replace(DANGEROUS_BLOCKS, '')
    .replace(EVENT_ATTRIBUTES, '')
    .replace(DANGEROUS_URL, '')
    .replace(HTML_TAG, (tag, name: string) =>
      ALLOWED_TAGS.has(name.toLowerCase()) ? tag : '',
    )
    .replace(CONTROL_CHARS, '');
}

/** 清洗标题（单行、截断到 200 字符，服务端上限；平台限制另行校验） */
export function sanitizeTitle(input: string): string {
  return input.replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** 清洗标签（去空白、去前导 #、截断） */
export function sanitizeTags(tags: readonly string[]): string[] {
  const cleaned = tags
    .map((tag) => tag.replace(CONTROL_CHARS, '').replace(/^#+/, '').trim())
    .filter((tag) => tag.length > 0 && tag.length <= 30);
  return [...new Set(cleaned)].slice(0, 30);
}
