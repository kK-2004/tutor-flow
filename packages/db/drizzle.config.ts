import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit 配置：SQLite 方言，迁移产物输出到 drizzle/。
 * generate 离线运行；migrate 由 src/scripts/migrate.ts 在运行时执行。
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema/**/*.ts',
  out: './drizzle',
  casing: 'snake_case',
  strict: true,
  verbose: true,
});
