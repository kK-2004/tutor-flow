/**
 * 正文提取器：无依赖的确定性 HTML 正文抽取。
 *
 * 提取产物只在研究步骤内即时使用（用完即弃，不持久化）；
 * 提取文本会被包裹为「不可信数据」传递给模型（见提示词隔离约定）。
 */
import type { ContentExtractor, ExtractedContent, FetchedPage } from './gateway-types.js';

/** 无信息量的结构标签：整块移除 */
const REMOVED_TAGS =
  /<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<header[\s\S]*?<\/header>|<footer[\s\S]*?<\/footer>|<aside[\s\S]*?<\/aside>|<form[\s\S]*?<\/form>|<noscript[\s\S]*?<\/noscript>|<template[\s\S]*?<\/template>|<!--[\s\S]*?-->/gi;

/** 块级标签：转换边界以保证文本可读分隔回 */
const BLOCK_BOUNDARY = /<\/(?:p|div|section|article|li|h[1-6]|tr|br|table|blockquote)>/gi;

/** 解码常见 HTML 实体（确定性子集） */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

/** 读取 HTML 元属性（title / canonical / lang） */
function readHtmlMeta(body: string): {
  title: string | null;
  canonical: string | null;
  lang: string | null;
} {
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1]?.trim() ?? null;
  const ogTitle =
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i
      .exec(body)?.[1]
      ?.trim() ?? null;
  const canonical =
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i
      .exec(body)?.[1]
      ?.trim() ?? null;
  const lang = /<html[^>]+lang=["']([a-zA-Z-]+)["']/i.exec(body)?.[1]?.trim() ?? null;
  return { title: title ?? ogTitle, canonical, lang };
}

/** 创建正文提取器 */
export function createHtmlContentExtractor(): ContentExtractor {
  return {
    extract(page: FetchedPage): ExtractedContent {
      const meta = readHtmlMeta(page.body);

      const withoutChrome = page.body.replace(REMOVED_TAGS, ' ');
      const withBreaks = withoutChrome.replace(BLOCK_BOUNDARY, '\n');
      const textOnly = withBreaks.replace(/<[^>]+>/g, ' ');
      const decoded = decodeEntities(textOnly);
      const text = decoded
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter((line) => line.length > 0)
        .join('\n')
        .trim();

      const canonical = meta.canonical ?? page.finalUrl;
      return {
        canonicalUrl: canonical,
        title: meta.title ?? canonical,
        text,
        language: meta.lang ?? 'unknown',
      };
    },
  };
}
