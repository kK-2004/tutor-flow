/** API 进程使用的模型运行时缓存，仅在启动或模型设置更新后刷新。 */
import { decryptLocalSecret } from '@tutor-flow/config/server';
import { getSetting, type DbClient } from '@tutor-flow/db';
import type { LlmModelsConfig, ModelSelection } from '@tutor-flow/domain';
import {
  createAiSdkLlmGateway,
  type LlmGateway,
  type LlmRequest,
  type LlmResponse,
} from '@tutor-flow/integrations';

const selectionKey = (selection: ModelSelection): string =>
  `${selection.providerId}:${selection.modelId}`;

export class ApiLlmRuntime {
  private config: LlmModelsConfig | null = null;
  private gateways = new Map<string, LlmGateway>();

  constructor(
    private readonly db: DbClient,
    private readonly databasePath: string,
  ) {}

  /** 从数据库读取一次配置与密钥，替换内存中的完整运行时快照。 */
  async refresh(): Promise<void> {
    const setting = await getSetting(this.db.db, 'llm_models');
    const config = (setting?.value as LlmModelsConfig | undefined) ?? null;
    const gateways = new Map<string, LlmGateway>();
    if (config !== null) {
      for (const provider of config.providers) {
        if (!provider.apiKeyEncrypted) continue;
        let apiKey: string;
        try {
          apiKey = await decryptLocalSecret(provider.apiKeyEncrypted, this.databasePath);
        } catch {
          continue;
        }
        for (const modelId of provider.models) {
          const selection = { providerId: provider.id, modelId };
          gateways.set(
            selectionKey(selection),
            createAiSdkLlmGateway({
              providerId: provider.id,
              baseURL: provider.baseUrl,
              model: modelId,
              apiKey,
              apiMode: provider.apiMode,
            }),
          );
        }
      }
    }
    this.config = config;
    this.gateways = gateways;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const taskSelection =
      this.config?.taskModels[request.task as keyof LlmModelsConfig['taskModels']];
    const selection = taskSelection ?? this.config?.defaultModel ?? null;
    if (selection === null) {
      throw new Error('请先在系统设置中配置默认模型');
    }
    const gateway = this.gateways.get(selectionKey(selection));
    if (gateway === undefined) {
      throw new Error('图片文字提取所用模型配置无效，请检查 Provider 和 API Key');
    }
    return gateway.complete(request);
  }
}
