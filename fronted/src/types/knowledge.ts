export interface KnowledgeBase {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  embeddingModel: string;
  embeddingDimension: number;
  /** 关联用户在「模型管理」中添加的 Embedding 模型 id；为空则回退本地 embeddingModel */
  embeddingLlmModelId: string | null;
  documentCount: number;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
  _count?: {
    documents: number;
    workspaces: number;
  };
}

export interface CreateKnowledgeBaseRequest {
  name: string;
  description?: string;
  embeddingModel: string;
  embeddingDimension: number;
  /** 自定义 Embedding 模型 id（可选，优先于 embeddingModel） */
  embeddingLlmModelId?: string;
}

/** 知识库的「向量版本」—— 切换模型 / 维度靠建新版本 + 重新向量化，而不是改现有向量 */
export interface EmbeddingVersion {
  id: string;
  knowledgeBaseId: string;
  modelId: string;
  llmModelId: string | null;
  dimensions: number;
  vectorTable: string;
  /** PENDING / PROCESSING / READY / FAILED / ARCHIVED */
  status: string;
  isActive: boolean;
  chunkTotal: number;
  chunkDone: number;
  chunkFailed: number;
  error: string | null;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateEmbeddingVersionRequest {
  /** 「模型管理」里的向量模型 id（推荐，自带实测维度） */
  llmModelId?: string;
  /** 直接指定模型标识（本地 Ollama 模型名） */
  modelId?: string;
  /** 目标维度；指定 llmModelId 时以实测维度为准 */
  dimensions?: number;
}

export interface UpdateKnowledgeBaseRequest {
  name?: string;
  description?: string;
  embeddingModel?: string;
  embeddingDimension?: number;
  /** 自定义 Embedding 模型 id；传空字符串表示清除 */
  embeddingLlmModelId?: string;
}
