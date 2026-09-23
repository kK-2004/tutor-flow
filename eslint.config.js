import tseslint from 'typescript-eslint';

/**
 * 仓库统一的 ESLint 平铺配置。
 *
 * 覆盖全部工作空间包与应用；构建产物与依赖目录一律忽略。
 * 后续任务（7.3）将在此追加管理后台的图标约束检查规则。
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      'pnpm-lock.yaml',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // 领域状态与外部协议使用全大写常量成员，不强制字面量成员排序风格
      '@typescript-eslint/no-explicit-any': 'error',
      // 未使用变量通常代表遗漏的错误处理或残留代码，统一报错
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
