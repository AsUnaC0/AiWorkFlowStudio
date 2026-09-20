export interface KnowledgeBase {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  embeddingModel: string;
  embeddingDimension: number;
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
}

export interface UpdateKnowledgeBaseRequest {
  name?: string;
  description?: string;
  embeddingModel?: string;
  embeddingDimension?: number;
}
