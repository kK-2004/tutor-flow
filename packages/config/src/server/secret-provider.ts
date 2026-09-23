/**
 * 密钥提供器接口与开发实现。
 *
 * 设计约束：
 * - 业务代码只持有 `secret_ref` 引用（例如 `env:XHS_ACCOUNT_COOKIES`），
 *   不在数据库、日志或客户端 API 中出现密钥明文；
 * - 生产环境的 Secret Manager 实现待定（见设计文档待确认事项），
 *   接口保持稳定，替换实现不影响领域代码。
 */

/** 密钥提供器：按引用解析密钥明文，仅供服务端短时使用 */
export interface SecretProvider {
  /** 解析密钥引用对应的明文；引用不存在或格式非法时抛出错误 */
  resolveSecret(ref: string): Promise<string>;
  /** 判断引用是否可解析，用于健康检查与账号授权状态展示 */
  hasSecret(ref: string): Promise<boolean>;
}

/**
 * 对密钥引用做部分脱敏，供日志与错误信息使用。
 *
 * 只保留前 8 个字符，避免完整变量名进入日志聚合系统。
 */
export function maskSecretRef(ref: string): string {
  if (ref.length <= 8) {
    return `${ref.slice(0, 2)}***`;
  }
  return `${ref.slice(0, 8)}***`;
}

/**
 * 环境变量密钥提供器（开发与测试用）。
 *
 * 引用格式固定为 `env:VAR_NAME`；生产实现可替换为 Vault/KMS 等后端。
 */
export class EnvSecretProvider implements SecretProvider {
  async resolveSecret(ref: string): Promise<string> {
    const varName = this.toVarName(ref);
    const value = process.env[varName];
    if (value === undefined || value === '') {
      throw new Error(`密钥引用 ${maskSecretRef(ref)} 对应的环境变量未配置`);
    }
    return value;
  }

  async hasSecret(ref: string): Promise<boolean> {
    try {
      await this.resolveSecret(ref);
      return true;
    } catch {
      return false;
    }
  }

  private toVarName(ref: string): string {
    if (!ref.startsWith('env:') || ref.length <= 4) {
      throw new Error(`不支持的密钥引用格式：${maskSecretRef(ref)}（应为 env:VAR_NAME）`);
    }
    return ref.slice(4);
  }
}

/** 测试用内存密钥提供器：密钥只存在于进程内存 */
export class InMemorySecretProvider implements SecretProvider {
  private readonly secrets: Map<string, string>;

  constructor(secrets: Record<string, string> = {}) {
    this.secrets = new Map(Object.entries(secrets));
  }

  async resolveSecret(ref: string): Promise<string> {
    const value = this.secrets.get(ref);
    if (value === undefined) {
      throw new Error(`密钥引用 ${maskSecretRef(ref)} 未注册`);
    }
    return value;
  }

  async hasSecret(ref: string): Promise<boolean> {
    return this.secrets.has(ref);
  }
}
