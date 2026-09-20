import { Injectable } from '@nestjs/common';
import {
  SearchOptions,
  SearchResult,
  VectorSearchOptions,
  KeywordSearchOptions,
  HybridSearchOptions,
} from './types';

/**
 * 知识库统一检索入口。
 *
 * 上层节点（RAG Node / LLM Node / Agent Knowledge Tool / ...）
 * 都应该依赖这个服务，而不是直接操作向量库或写 SQL。
 *
 * 升级检索能力时（Vector → +Keyword → +Hybrid → +Rerank）
 * 只改这个服务的内部实现即可，上层无感知。
 */
@Injectable()
export class KnowledgeRetrievalService {
  /**
   * 通用检索入口，根据 mode 自动路由到对应实现。
   * 默认 hybrid（先做关键词兜底，再做向量精排）。
   */
  async search(options: SearchOptions): Promise<SearchResult[]> {
    const mode = options.mode ?? 'hybrid';

    switch (mode) {
      case 'vector':
        return this.vectorSearch({
          knowledgeBaseIds: options.knowledgeBaseIds,
          queryVector: await this.embed(options.query),
          topK: options.topK,
          scoreThreshold: options.scoreThreshold,
        });

      case 'keyword':
        return this.keywordSearch({
          knowledgeBaseIds: options.knowledgeBaseIds,
          query: options.query,
          topK: options.topK,
        });

      case 'hybrid':
      default:
        return this.hybridSearch({
          knowledgeBaseIds: options.knowledgeBaseIds,
          query: options.query,
          topK: options.topK,
        });
    }
  }

  /** 向量检索 */
  async vectorSearch(_options: VectorSearchOptions): Promise<SearchResult[]> {
    // TODO: 接入 VectorStoreService + EmbeddingService
    throw new Error('vectorSearch 尚未实现');
  }

  /** 关键词 / 全文检索 */
  async keywordSearch(_options: KeywordSearchOptions): Promise<SearchResult[]> {
    // TODO: PostgreSQL FULLTEXT / Elasticsearch / BM25
    throw new Error('keywordSearch 尚未实现');
  }

  /**
   * 混合检索：向量 + 关键词，使用 Reciprocal Rank Fusion (RRF) 融合。
   * 公式：score(d) = Σ 1 / (k + rank_i(d))
   */
  async hybridSearch(options: HybridSearchOptions): Promise<SearchResult[]> {
    const k = options.rrfK ?? 60;
    const topK = options.topK ?? 5;

    // 并发跑两路
    const [vectorResults, keywordResults] = await Promise.all([
      this.vectorSearch({
        knowledgeBaseIds: options.knowledgeBaseIds,
        queryVector: await this.embed(options.query),
        topK: topK * 4, // 多取一些给 RRF 融合
      }),
      this.keywordSearch({
        knowledgeBaseIds: options.knowledgeBaseIds,
        query: options.query,
        topK: topK * 4,
      }),
    ]);

    // RRF 融合
    const scores = new Map<string, { result: SearchResult; score: number }>();

    vectorResults.forEach((r, rank) => {
      const existing = scores.get(r.chunkId);
      const fusedScore = 1 / (k + rank + 1);
      if (existing) {
        existing.score += fusedScore;
      } else {
        scores.set(r.chunkId, { result: r, score: fusedScore });
      }
    });

    keywordResults.forEach((r, rank) => {
      const existing = scores.get(r.chunkId);
      const fusedScore = 1 / (k + rank + 1);
      if (existing) {
        existing.score += fusedScore;
      } else {
        scores.set(r.chunkId, { result: r, score: fusedScore });
      }
    });

    return [...scores.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ result, score }) => ({ ...result, score }));
  }

  // ---------------------------------------------------------------------------
  // 内部工具
  // ---------------------------------------------------------------------------

  /** 生成查询向量（占位，后续注入 EmbeddingService） */
  private async embed(_query: string): Promise<number[]> {
    // TODO: 调用 EmbeddingService.embed()
    throw new Error('embed 尚未实现');
  }
}
