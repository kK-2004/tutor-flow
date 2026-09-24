import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { validateMigrationManifest } from '../../scripts/check-db-migrations.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const migrationDir = path.join(root, 'packages/db/drizzle');

describe('数据库迁移清单校验', () => {
  it('当前迁移文件与 Drizzle journal 一致', () => {
    const files = readdirSync(migrationDir);
    const journal = JSON.parse(
      readFileSync(path.join(migrationDir, 'meta/_journal.json'), 'utf8'),
    );
    expect(validateMigrationManifest(files, journal)).toEqual([]);
  });

  it('拒绝 journal 中重复版本、缺失文件和未登记文件', () => {
    const errors = validateMigrationManifest(
      ['0000_initial.sql', '0001_second.sql', '0002_orphan.sql'],
      {
        entries: [
          { idx: 0, tag: '0000_initial' },
          { idx: 1, tag: '0000_missing' },
        ],
      },
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('版本重复'),
        expect.stringContaining('不存在的迁移'),
        expect.stringContaining('未登记在 journal'),
      ]),
    );
  });
});
