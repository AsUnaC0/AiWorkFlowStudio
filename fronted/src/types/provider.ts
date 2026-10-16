export type LlmProviderType =
  | "ollama"
  | "openai"
  | "deepseek"
  | "openai-compatible";

/**
 * 模型能力标签（可多选，不是互斥的「类型」）。
 * 一个多模态推理模型可以同时拥有 chat + vision + reasoning。
 */
export type ModelCapability =
  | "CHAT"
  | "STREAM"
  | "TOOLS"
  | "EMBEDDING"
  | "VISION"
  | "REASONING"
  | "RERANK"
  | "IMAGE_GENERATION";

/** 输入 / 输出模态 */
export type Modality = "text" | "image" | "audio";

export type LlmConfigStatus = "UNKNOWN" | "CONNECTED" | "ERROR" | "DISABLED";

export interface LlmModel {
  id: string;
  configId: string;
  provider: LlmProviderType;
  modelId: string;
  displayName: string | null;
  capabilities: ModelCapability[];
  inputModalities: string[];
  outputModalities: string[];
  /** 仅向量模型有意义：实测输出维度 */
  embeddingDimensions: number | null;
  maxInputTokens: number | null;
  /** 是否通过实测验证（连接 + 能力 + 维度） */
  isVerified: boolean;
  verifiedAt: string | null;
  isDefault: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 模型实测验证结果 */
export interface VerifyModelResult {
  ok: boolean;
  dimensions: number | null;
  latencyMs: number;
  checked: string[];
  error?: string;
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
  /** 编辑时顺带添加 / 更新的单个模型（只添加填写的这个） */
  modelId?: string;
  displayName?: string;
  capabilities?: ModelCapability[];
}

/** 向已有配置添加指定模型（不再全量拉取） */
export interface AddLlmModelsRequest {
  modelIds: string[];
  capabilities?: ModelCapability[];
}

/** 远端模型列表（只拉取不落地）：models 为远端全部，existing 为已入库的 */
export interface RemoteModelsResult {
  models: string[];
  existing: string[];
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
  CHAT: "文本生成",
  STREAM: "流式",
  TOOLS: "工具调用",
  EMBEDDING: "向量化",
  VISION: "视觉理解",
  REASONING: "推理",
  RERANK: "重排序",
  IMAGE_GENERATION: "图片生成",
};

/** 能力说明（表单里作为 tooltip，避免误解「能理解图片 ≠ 能生成图片」） */
export const CAPABILITY_TIPS: Record<ModelCapability, string> = {
  CHAT: "聊天、总结、分类、改写、内容生成",
  STREAM: "支持流式输出",
  TOOLS: "支持 Function Calling 工具调用",
  EMBEDDING: "文本向量化、知识库检索、语义相似度；输出是固定维度向量而非文本",
  VISION: "图片问答、OCR 场景理解、图文输入（与「图片生成」无关）",
  REASONING: "复杂问题分析、多步骤规划、数学与逻辑推理",
  RERANK: "对召回的知识片段重新评分排序（增强 RAG）",
  IMAGE_GENERATION: "文生图、图像创作（与「视觉理解」无关）",
};
