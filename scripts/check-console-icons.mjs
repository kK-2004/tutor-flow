import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('apps/console/src');
const violations = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(target);
      continue;
    }
    if (!/\.(tsx?|css)$/.test(entry.name)) continue;
    const source = await readFile(target, 'utf8');
    if (/<\/?svg\b|\.svg\b|from\s+['"][^'"]*svg/i.test(source)) {
      violations.push(`${target}: 禁止使用 SVG 文件或组件`);
    }
    if (/\p{Extended_Pictographic}/u.test(source)) {
      violations.push(`${target}: 禁止使用硬编码 Emoji`);
    }
  }
}

await walk(root);
if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log('管理台图标约束检查通过');
}
