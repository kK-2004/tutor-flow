export const LLM_MODELS_UPDATED_CHANNEL = 'tutor-flow:llm-models:updated' as const;

export const LLM_TASKS = [
  { id: 'query_planning', label: '搜索规划' },
  { id: 'image_text_extraction', label: '图片文字提取' },
  { id: 'claim_extraction', label: '事实提取' },
  { id: 'direction_generation', label: '内容方向生成' },
  { id: 'canonical_article', label: '规范文章生成' },
  { id: 'xhs_adapt', label: '小红书文案生成' },
] as const;

export type LlmTaskId = (typeof LLM_TASKS)[number]['id'];
export type LlmApiMode = 'chat' | 'responses';

export interface ModelProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiMode: LlmApiMode;
  apiKeyEncrypted?: string;
  models: string[];
}

export interface ModelSelection {
  providerId: string;
  modelId: string;
}

export interface LlmModelsConfig {
  providers: ModelProvider[];
  defaultModel: ModelSelection | null;
  taskModels: Partial<Record<LlmTaskId, ModelSelection | null>>;
}
