/** 检索模式 */
export type SearchMode = 'vector' | 'keyword' | 'hybrid';

/** 通用检索选项 */
export interface SearchOptions {
  /** 要检索的知识库 ID 列表 */
  knowledgeBaseIds: string[];
  /** 用户查询文本 */
  query: string;
  /** 返回前 K 条，默认 5 */
  topK?: number;
  /** 最低相似度阈值 0~1，低于则过滤掉 */
  scoreThreshold?: number;
  /** 检索模式，默认 hybrid */
  mode?: SearchMode;
  /** 是否在返回中附带文档信息 */
  includeDocument?: boolean;
}

/** 向量检索选项 */
export interface VectorSearchOptions {
  knowledgeBaseIds: string[];
  queryVector: number[];
  topK?: number;
  scoreThreshold?: number;
}

/** 关键词检索选项 */
export interface KeywordSearchOptions {
  knowledgeBaseIds: string[];
  query: string;
  topK?: number;
}

/** 混合检索选项（RRF 融合） */
export interface HybridSearchOptions {
  knowledgeBaseIds: string[];
  query: string;
  topK?: number;
  /** 向量和关键词结果的权重 / RRF k 参数 */
  rrfK?: number;
}

/** 单条检索结果 */
export interface SearchResult {
  chunkId: string;
  documentId: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
  /** 文档文件名（includeDocument=true 时返回） */
  fileName?: string;
}
