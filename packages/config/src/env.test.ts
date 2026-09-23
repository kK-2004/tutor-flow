import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { apiEnvSchema, workerEnvSchema } from './env-schema.js';
import {
  loadApiEnv,
  loadConsoleServerEnv,
  loadWorkerEnv,
  resetEnvCacheForTests,
} from './server/env.js';
import {
  EnvSecretProvider,
  InMemorySecretProvider,
  maskSecretRef,
} from './server/secret-provider.js';

/**
 * 环境配置与密钥提供器测试。
 *
 * 覆盖：缺项 fail-fast、默认值、未知键拒绝、密钥引用解析与脱敏。
 */
describe('环境 schema 校验', () => {
  const validApiEnv = {
    SQLITE_PATH: './data/tutor-flow.db',
    REDIS_URL: 'redis://localhost:6379',
  };

  it('接受合法 API 环境并应用默认值', () => {
    // 直接从合成对象构造，避免依赖真实 process.env
    const parsed = apiEnvSchema.parse({ ...validApiEnv });
    expect(parsed.NODE_ENV).toBe('development');
    expect(parsed.LOG_LEVEL).toBe('info');
    expect(parsed.API_PORT).toBe(4000);
  });

  it('缺少必填项时抛出校验错误', () => {
    expect(() => apiEnvSchema.parse({})).toThrow();
  });

  it('拒绝未声明的键（strict 模式）', () => {
    expect(() =>
      apiEnvSchema.parse({
        ...validApiEnv,
        SECRET_UNDECLARED_KEY: 'should-fail',
      }),
    ).toThrow();
  });

  it('生产 Worker 使用 MCP 镜像引用即可启动', () => {
    const workerEnv = {
      NODE_ENV: 'production',
      SQLITE_PATH: './data/tutor-flow.db',
      REDIS_URL: 'redis://localhost:6379',
      XHS_MCP_URL: 'http://xiaohongshu-mcp:18060/mcp',
    };
    expect(workerEnvSchema.parse(workerEnv).XHS_MCP_URL).toBe(workerEnv.XHS_MCP_URL);
  });
});

describe('服务端环境加载器', () => {
  // 与宿主机 shell 环境隔离，避免已有变量影响断言
  const KEYS_TO_CLEAN = [
    'DATABASE_URL',
    'SQLITE_PATH',
    'REDIS_URL',
    'XHS_MCP_URL',
    'INTERNAL_API_TOKEN',
    'API_HOST',
    'API_PORT',
  ] as const;

  beforeEach(() => {
    resetEnvCacheForTests();
    for (const key of KEYS_TO_CLEAN) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    resetEnvCacheForTests();
    for (const key of KEYS_TO_CLEAN) {
      delete process.env[key];
    }
  });

  it('API 环境缺项时 fail-fast', () => {
    expect(() => loadApiEnv()).toThrow();
  });

  it('提供完整变量时解析成功并缓存', () => {
    process.env['SQLITE_PATH'] = './data/tutor-flow.db';
    process.env['REDIS_URL'] = 'redis://localhost:6379';
    const first = loadApiEnv();
    const second = loadApiEnv();
    expect(second).toBe(first);
  });

  it('Worker 环境接受可选的 MCP 地址', () => {
    process.env['SQLITE_PATH'] = './data/tutor-flow.db';
    process.env['REDIS_URL'] = 'redis://localhost:6379';
    const env = loadWorkerEnv();
    expect(env.XHS_MCP_URL).toBeUndefined();
    // 清缓存后重新加载，验证非法值会被拒绝
    process.env['XHS_MCP_URL'] = 'not-a-url';
    resetEnvCacheForTests();
    expect(() => loadWorkerEnv()).toThrow();
  });

  it('管理台服务端环境不含任何密钥字段', () => {
    const env = loadConsoleServerEnv();
    // 基础形态：只有环境与 API 地址两个非敏感字段
    expect(
      Object.keys(env)
        .filter((key) => key !== 'INTERNAL_API_TOKEN')
        .sort(),
    ).toEqual(['CONSOLE_API_BASE_URL', 'NODE_ENV']);
  });
});

describe('密钥提供器', () => {
  it('EnvSecretProvider 解析 env: 引用', async () => {
    const provider = new EnvSecretProvider();
    process.env['TEST_SECRET_FOR_CONFIG'] = 'plain-value';
    await expect(provider.resolveSecret('env:TEST_SECRET_FOR_CONFIG')).resolves.toBe(
      'plain-value',
    );
    await expect(provider.hasSecret('env:TEST_SECRET_FOR_CONFIG')).resolves.toBe(true);
    delete process.env['TEST_SECRET_FOR_CONFIG'];
  });

  it('EnvSecretProvider 对缺失与非法引用抛错', async () => {
    const provider = new EnvSecretProvider();
    await expect(provider.resolveSecret('env:DEFINITELY_MISSING_VAR')).rejects.toThrow();
    await expect(provider.resolveSecret('vault://prod/cookie')).rejects.toThrow(
      /不支持的密钥引用格式/,
    );
    await expect(provider.hasSecret('env:DEFINITELY_MISSING_VAR')).resolves.toBe(false);
  });

  it('InMemorySecretProvider 仅暴露已注册引用', async () => {
    const provider = new InMemorySecretProvider({ 'env:A': '1' });
    await expect(provider.resolveSecret('env:A')).resolves.toBe('1');
    await expect(provider.resolveSecret('env:B')).rejects.toThrow();
  });

  it('maskSecretRef 不暴露完整变量名', () => {
    const masked = maskSecretRef('env:XHS_ACCOUNT_COOKIE_JAR');
    expect(masked.startsWith('env:XHS_')).toBe(true);
    expect(masked).toContain('***');
    expect(masked.length).toBeLessThanOrEqual(11);
  });
});
