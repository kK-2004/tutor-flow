import { defineConfig } from 'vitest/config';

/**
 * 仓库统一的 Vitest 配置。
 *
 * 单元测试与各包源码同目录（*.test.ts），集成测试在 tests/ 下；
 * 依赖工作空间包先完成 tsc 构建（见根 package.json 的 test 脚本）。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    // 集成测试共享数据库与 Redis，测试文件必须串行执行
    fileParallelism: false,
    // 防止个别测试悬挂拖垮整体
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
