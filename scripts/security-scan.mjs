import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('.');
const ignored = new Set(['node_modules', '.git', 'dist', '.next', 'coverage', 'data']);
const findings = [];
const secretPatterns = [
  /-----BEGIN (?:RSA|EC|OPENSSH|PRIVATE) KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /(?:cookie|set-cookie)\s*[:=]\s*['"][^$\n'"]{24,}['"]/i,
];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(target);
      continue;
    }
    if (/(\.db|\.png|\.woff2|\.lock)$/.test(entry.name)) continue;
    const source = await readFile(target, 'utf8').catch(() => '');
    for (const pattern of secretPatterns) {
      if (pattern.test(source)) {
        findings.push(`${target}: 命中敏感信息模式 ${pattern}`);
      }
    }
  }
}

await walk(root);
if (findings.length > 0) {
  console.error(findings.join('\n'));
  process.exitCode = 1;
} else {
  console.log('敏感信息扫描通过');
}
