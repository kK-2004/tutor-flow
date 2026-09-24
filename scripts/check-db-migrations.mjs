import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateMigrationManifest(files, journal) {
  const errors = [];
  const sqlFiles = files.filter((file) => file.endsWith('.sql')).sort();
  const entries = journal.entries;
  if (!Array.isArray(entries)) return ['迁移 journal 缺少 entries 数组'];

  const versions = new Set();
  const tags = new Set();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.idx !== index)
      errors.push(`journal idx 不连续：期望 ${index}，实际 ${entry.idx}`);
    if (
      typeof entry.tag !== 'string' ||
      !/^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*$/.test(entry.tag)
    ) {
      errors.push(`迁移 tag 格式无效：${String(entry.tag)}`);
      continue;
    }
    const version = entry.tag.slice(0, 4);
    if (versions.has(version)) errors.push(`迁移版本重复：${version}`);
    if (tags.has(entry.tag)) errors.push(`迁移 tag 重复：${entry.tag}`);
    versions.add(version);
    tags.add(entry.tag);
    if (!sqlFiles.includes(`${entry.tag}.sql`)) {
      errors.push(`journal 引用了不存在的迁移：${entry.tag}.sql`);
    }
  }

  for (const file of sqlFiles) {
    const tag = file.slice(0, -4);
    if (!/^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*$/.test(tag)) {
      errors.push(`迁移文件名格式无效：${file}`);
    } else if (!tags.has(tag)) {
      errors.push(`迁移文件未登记在 journal：${file}`);
    }
  }
  return errors;
}

const invokedPath = process.argv[1] === undefined ? null : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const migrationDir = path.join(root, 'packages/db/drizzle');
  const files = readdirSync(migrationDir);
  const journal = JSON.parse(
    readFileSync(path.join(migrationDir, 'meta/_journal.json'), 'utf8'),
  );
  const errors = validateMigrationManifest(files, journal);
  if (errors.length > 0) {
    for (const error of errors) console.error(`数据库迁移校验失败：${error}`);
    process.exitCode = 1;
  } else {
    console.log(`数据库迁移清单有效：${journal.entries.length} 个迁移`);
  }
}
