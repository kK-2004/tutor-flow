import type { NextConfig } from 'next';

/**
 * 管理后台 Next.js 配置。
 *
 * API 代理由 app/api/[...path]/route.ts 在运行时处理，以便完整透传
 * HttpOnly 会话 Cookie。
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  logging: {
    incomingRequests: false,
  },
};

export default nextConfig;
