/**
 * 管理台浏览器端可用的配置。
 *
 * 安全约束：此入口只允许暴露 NEXT_PUBLIC_ 开头且不敏感的值；
 * 任何凭据、密钥引用都不得出现在此处，也不得从 client 代码导入
 * `@tutor-flow/config/server`（服务端专用入口）。
 */

/** 管理台浏览器端配置形状 */
export interface ClientConfig {
  /** API 基础地址（SSE 与 REST 请求使用） */
  apiBaseUrl: string;
}

/** 读取浏览器端安全配置；缺失时回退到同源相对路径 */
export function loadClientConfig(): ClientConfig {
  // Turbopack/Next 只会内联 NEXT_PUBLIC_ 前缀变量，且此处为非敏感地址
  const rawBaseUrl =
    typeof process !== 'undefined' && process.env['NEXT_PUBLIC_API_BASE_URL']
      ? process.env['NEXT_PUBLIC_API_BASE_URL']
      : '';
  return Object.freeze({
    apiBaseUrl: rawBaseUrl !== '' ? rawBaseUrl : 'http://127.0.0.1:4000',
  });
}
