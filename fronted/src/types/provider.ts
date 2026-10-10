export type LlmProviderType =
  | "ollama"
  | "openai"
  | "deepseek"
  | "openai-compatible";

export type ModelCapability = "CHAT" | "STREAM" | "TOOLS" | "EMBEDDING";

export type LlmConfigStatus = "UNKNOWN" | "CONNECTED" | "ERROR" | "DISABLED";

export interface LlmModel {
  id: string;
  configId: string;
  provider: LlmProviderType;
  modelId: string;
  displayName: string | null;
  capabilities: ModelCapability[];
  isDefault: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LlmProviderConfig {
  id: string;
  ownerId: string;
  name: string;
  provider: LlmProviderType;
  baseUrl: string | null;
  status: LlmConfigStatus;
  lastError: string | null;
  apiKeyMasked: string | null;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
  models: LlmModel[];
}

export interface CreateLlmConfigRequest {
  name: string;
  provider: LlmProviderType;
  baseUrl?: string;
  apiKey?: string;
  modelId?: string;
  displayName?: string;
  capabilities?: ModelCapability[];
}

export interface UpdateLlmConfigRequest {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  disabled?: boolean;
}

export interface UpdateLlmModelRequest {
  displayName?: string;
  capabilities?: ModelCapability[];
  enabled?: boolean;
}

export interface TestLlmConfigRequest {
  provider: LlmProviderType;
  baseUrl?: string;
  apiKey?: string;
  modelId?: string;
}

export interface TestLlmConfigResult {
  ok: boolean;
  models: string[];
  error?: string;
}

export const PROVIDER_LABELS: Record<LlmProviderType, string> = {
  ollama: "Ollama（本地模型）",
  openai: "OpenAI（官方 API）",
  deepseek: "DeepSeek（云端 API）",
  "openai-compatible": "OpenAI 兼容（其他服务）",
};

export const CAPABILITY_LABELS: Record<ModelCapability, string> = {
  CHAT: "对话",
  STREAM: "流式",
  TOOLS: "工具调用",
  EMBEDDING: "向量嵌入",
};
