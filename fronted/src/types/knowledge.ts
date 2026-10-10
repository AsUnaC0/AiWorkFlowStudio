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

export interface UpdateKnowledgeBaseRequest {
  name?: string;
  description?: string;
  embeddingModel?: string;
  embeddingDimension?: number;
  /** 自定义 Embedding 模型 id；传空字符串表示清除 */
  embeddingLlmModelId?: string;
}
