/** 研究资料中保存的内容中心图片引用。 */
export interface ResearchDocumentImage {
  fileId: number;
  alt: string;
}

const RESEARCH_IMAGE_PATTERN = /!\[([^\]\r\n]*)\]\(content-center:\/\/file\/(\d+)\)/g;

/** 创建只包含稳定文件标识的 Markdown 图片引用。 */
export function formatResearchDocumentImage(fileId: number, name: string): string {
  const alt = name.replace(/[\[\]\r\n]/g, ' ').trim() || '图片';
  return `![${alt}](content-center://file/${fileId})`;
}

/** 提取 Markdown 中的内容中心图片，按首次出现顺序去重。 */
export function parseResearchDocumentImages(markdown: string): ResearchDocumentImage[] {
  const images: ResearchDocumentImage[] = [];
  const seen = new Set<number>();
  for (const match of markdown.matchAll(RESEARCH_IMAGE_PATTERN)) {
    const fileId = Number(match[2]);
    if (!Number.isSafeInteger(fileId) || fileId <= 0 || seen.has(fileId)) continue;
    seen.add(fileId);
    images.push({ fileId, alt: match[1]?.trim() || '图片' });
  }
  return images;
}

/** 移除内部引用地址，仅保留图片在文章中的位置说明。 */
export function redactResearchDocumentImageUrls(markdown: string): string {
  return markdown.replace(RESEARCH_IMAGE_PATTERN, (_reference, alt: string) => {
    const label = alt.trim() || '图片';
    return `[文章图片：${label}]`;
  });
}
