/**
 * Publisher Adapter 契约（任务 6.2）。
 *
 * 仅保留历史发布记录的契约与测试模拟适配器；运行时不注册发布消费。
 * 五个操作对应旧规格：
 * checkAuth / validate / preview / publish / queryStatus。
 *
 * 安全约定：账号 Cookie 等密钥以 secretValue 短时挂载，
 * 适配器不得将其写入日志或返回值。
 */

import type { DraftMedia } from '@tutor-flow/domain';

/** 账号引用（凭据已由密钥提供器解析，适配器内短时使用） */
export interface PublisherAccountRef {
  accountId: string;
  /** 账号别名（日志用，非敏感） */
  alias: string;
  /** 解析后的凭据（Cookie 会话串），用后即弃 */
  secretValue: string;
}

/** 待发布的小红书图文内容 */
export interface PublishContent {
  title: string;
  body: string;
  tags: string[];
  /** 媒体引用（有序，首图为封面）；适配器负责换取可访问地址 */
  mediaObjectKeys: DraftMedia[];
  /** 是否携带 AIGC 标识发布 */
  aigcDisclosed: boolean;
}

/** 授权健康状态 */
export type PublisherAuthHealth = 'HEALTHY' | 'AUTH_REQUIRED' | 'CHALLENGE_REQUIRED';

/** checkAuth 结果 */
export interface AuthCheckResult {
  healthy: PublisherAuthHealth;
  /** 需要人工处理时的中文说明（脱敏） */
  message?: string;
}

/** validate 结果 */
export interface PublishValidateResult {
  valid: boolean;
  issues: string[];
}

/** preview 结果 */
export interface PublishPreviewResult {
  payload: Record<string, unknown>;
}

/** publish 结果：平台回执的最小集 */
export interface PublishResult {
  platformPostId: string;
  platformUrl?: string;
}

/** queryStatus 结果 */
export interface PublishStatusResult {
  exists: boolean;
  url?: string;
  /** 平台侧状态说明（脱敏） */
  note?: string;
}

/** Publisher Adapter 契约 */
export interface PublisherAdapter {
  /** sidecar 模式由上游容器持有登录态，不解析平台账号 Cookie。 */
  sessionMode?: 'sidecar' | 'per_account';
  /** 授权健康检查 */
  checkAuth(account: PublisherAccountRef): Promise<AuthCheckResult>;
  /** 发布前校验（适配器能力维度，如媒体格式支持） */
  validate(
    account: PublisherAccountRef,
    content: PublishContent,
  ): Promise<PublishValidateResult>;
  /** 预览实际生效载荷（不产生外部副作用） */
  preview(
    account: PublisherAccountRef,
    content: PublishContent,
  ): Promise<PublishPreviewResult>;
  /** 执行发布（外部副作用唯一入口） */
  publish(account: PublisherAccountRef, content: PublishContent): Promise<PublishResult>;
  /** 平台侧状态核验（发布结果未知时先核验再处置） */
  queryStatus(
    account: PublisherAccountRef,
    platformPostId: string,
  ): Promise<PublishStatusResult>;
}

/** 适配器契约冒烟校验结果。 */
export interface PublisherContractCheck {
  valid: boolean;
  issues: string[];
}

/**
 * 对 sidecar 适配器执行无外部发布副作用的契约检查。
 *
 * 检查只调用授权、校验和预览；真正的发布由测试账号的显式集成测试负责，
 * 避免部署探针意外产生平台内容。
 */
export async function checkPublisherAdapterContract(
  adapter: PublisherAdapter,
  account: PublisherAccountRef,
): Promise<PublisherContractCheck> {
  const issues: string[] = [];
  const sample: PublishContent = {
    title: '契约校验示例',
    body: '这是用于验证发布适配器输入输出契约的示例正文。',
    tags: ['契约校验'],
    mediaObjectKeys: ['contract/cover.png'],
    aigcDisclosed: true,
  };
  try {
    const auth = await adapter.checkAuth(account);
    if (!['HEALTHY', 'AUTH_REQUIRED', 'CHALLENGE_REQUIRED'].includes(auth.healthy)) {
      issues.push('checkAuth 返回了未知健康状态');
    }
  } catch (error) {
    issues.push(
      `checkAuth 调用失败：${error instanceof Error ? error.message : '未知错误'}`,
    );
  }
  try {
    const validation = await adapter.validate(account, sample);
    if (typeof validation.valid !== 'boolean' || !Array.isArray(validation.issues)) {
      issues.push('validate 返回结构不完整');
    }
  } catch (error) {
    issues.push(
      `validate 调用失败：${error instanceof Error ? error.message : '未知错误'}`,
    );
  }
  try {
    const preview = await adapter.preview(account, sample);
    if (typeof preview.payload !== 'object' || preview.payload === null) {
      issues.push('preview 未返回对象载荷');
    }
  } catch (error) {
    issues.push(
      `preview 调用失败：${error instanceof Error ? error.message : '未知错误'}`,
    );
  }
  return { valid: issues.length === 0, issues };
}

/** 适配器错误的错误码分类（发布 Worker 据此处置） */
export type PublisherErrorCode =
  | 'TRANSIENT'
  | 'AUTH_EXPIRED'
  | 'CHALLENGE_REQUIRED'
  | 'SELECTOR'
  | 'UNKNOWN_OUTCOME'
  | 'NEEDS_HUMAN'
  | 'REJECTED';

/** 适配器错误：分类驱动重试与转人工（见任务 6.9） */
export class PublisherError extends Error {
  readonly code: PublisherErrorCode;
  /** 外部副作用是否可能已发生（超时/响应丢失时为 true，禁止盲目重试） */
  readonly sideEffectSuspected: boolean;

  constructor(code: PublisherErrorCode, message: string, sideEffectSuspected = false) {
    super(message);
    this.name = 'PublisherError';
    this.code = code;
    this.sideEffectSuspected = sideEffectSuspected;
  }
}

/**
 * 端到端测试用模拟适配器（任务 6.2）。
 *
 * 行为可脚本化：正常发布、鉴权过期、验证码挑战、选择器失效、
 * 响应丢失（副作用已发生但无回执）、发布被平台拒绝。
 */
export class FakePublisherAdapter implements PublisherAdapter {
  /** 已执行的发布（供测试断言外部副作用次数） */
  readonly publishedCalls: Array<{ account: string; title: string }> = [];
  private readonly statusBook = new Map<string, { exists: boolean; url?: string }>();
  private nextPostId = 1;

  /** 覆盖下一次 publish 的行为 */
  mode:
    'normal' | 'auth_expired' | 'challenge' | 'selector' | 'lost_response' | 'rejected' =
    'normal';

  async checkAuth(_account: PublisherAccountRef): Promise<AuthCheckResult> {
    if (this.mode === 'auth_expired') {
      return { healthy: 'AUTH_REQUIRED', message: 'Cookie 已过期，请重新登录' };
    }
    if (this.mode === 'challenge') {
      return { healthy: 'CHALLENGE_REQUIRED', message: '需要扫码验证' };
    }
    return { healthy: 'HEALTHY' };
  }

  async validate(
    _account: PublisherAccountRef,
    content: PublishContent,
  ): Promise<PublishValidateResult> {
    if (content.mediaObjectKeys.length === 0) {
      return { valid: false, issues: ['缺少媒体文件'] };
    }
    return { valid: true, issues: [] };
  }

  async preview(
    _account: PublisherAccountRef,
    content: PublishContent,
  ): Promise<PublishPreviewResult> {
    return { payload: { title: content.title, tags: content.tags } };
  }

  async publish(
    account: PublisherAccountRef,
    content: PublishContent,
  ): Promise<PublishResult> {
    this.publishedCalls.push({ account: account.accountId, title: content.title });
    switch (this.mode) {
      case 'auth_expired':
        throw new PublisherError('AUTH_EXPIRED', 'Cookie 已过期');
      case 'challenge':
        throw new PublisherError('CHALLENGE_REQUIRED', '触发扫码验证');
      case 'selector':
        throw new PublisherError('SELECTOR', '发布按钮选择器失效');
      case 'lost_response':
        // 副作用已发生（平台可能已发布）但响应丢失
        throw new PublisherError('UNKNOWN_OUTCOME', '发布请求超时，结果未知', true);
      case 'rejected':
        throw new PublisherError('REJECTED', '内容被平台拒绝');
      default: {
        const postId = `post-${this.nextPostId}`;
        this.nextPostId += 1;
        this.statusBook.set(postId, {
          exists: true,
          url: `https://xiaohongshu.com/${postId}`,
        });
        return {
          platformPostId: postId,
          platformUrl: `https://xiaohongshu.com/${postId}`,
        };
      }
    }
  }

  async queryStatus(
    _account: PublisherAccountRef,
    platformPostId: string,
  ): Promise<PublishStatusResult> {
    const entry = this.statusBook.get(platformPostId);
    if (entry === undefined) {
      return { exists: false, note: '平台侧未找到该内容' };
    }
    return { exists: entry.exists, url: entry.url };
  }
}
