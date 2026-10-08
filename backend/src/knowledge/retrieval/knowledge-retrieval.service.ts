import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { VectorStoreService } from '../vector/vector-store.service';
import type {
  SearchOptions,
  SearchResult,
  VectorSearchOptions,
  KeywordSearchOptions,
  HybridSearchOptions,
} from './types';
import type { VectorHit, KeywordHit } from '../vector/vector-store.service';

/**
 * 知识库统一检索入口（v1.4 共享检索服务）。
 *
 * 上层节点（RAG Node / LLM Node 简单模式 / Agent Knowledge Tool）
 * 都应该依赖这个服务，而不是直接操作 VectorStoreService 或写 SQL。
 *
 * 底层依赖：
 *   - VectorStoreService  → pgvector 检索
 *   - EmbeddingService    → 查询向量化
 *   - PrismaService       → 解析知识库绑定的 embedding 模型
 *
 * 检索能力升级时（Vector → +Keyword → +Hybrid → +Rerank）
 * 只改这个服务的内部实现即可，上层无感知。
 */
@Injectable()
export class KnowledgeRetrievalService {
  constructor(
    private readonly vectorStoreService: VectorStoreService,
    private readonly embeddingService: EmbeddingService,
    private readonly prisma: PrismaService,
  ) {}

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
          queryVector: await this.embed(
            options.query,
            options.embeddingModel,
            options.knowledgeBaseIds,
          ),
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
          rrfK: undefined,
          embeddingModel: options.embeddingModel,
        });
    }
  }

  /** 向量检索 */
  async vectorSearch(options: VectorSearchOptions): Promise<SearchResult[]> {
    const { knowledgeBaseIds, queryVector, topK = 5, scoreThreshold } = options;

    if (knowledgeBaseIds.length === 0) return [];

    // scoreThreshold 是相似度阈值（0~1，越大越严格）；
    // VectorStoreService 接收的是距离阈值（0~2，越小越严格）
    // 转换：距离阈值 = 1 - 相似度阈值；未指定时用 VectorStoreService 默认值
    const distanceThreshold = scoreThreshold != null ? 1 - scoreThreshold : 0.8;

    const hits = await this.vectorStoreService.vectorSearch(
      knowledgeBaseIds,
      queryVector,
      topK,
      distanceThreshold,
    );

    // score 统一为相似度语义（越大越好）：相似度 = 1 - 余弦距离
    return hits.map((h) => this.toSearchResult(h, 1 - h.distance));
  }

  /** 关键词 / 全文检索 */
  async keywordSearch(options: KeywordSearchOptions): Promise<SearchResult[]> {
    const { knowledgeBaseIds, query, topK = 5 } = options;

    if (knowledgeBaseIds.length === 0 || !query.trim()) return [];

    const hits = await this.vectorStoreService.keywordSearch(
      knowledgeBaseIds,
      query,
      topK,
    );

    // 关键词模式 score 直接用 ts_rank（PostgreSQL 返回的原始相关度）
    return hits.map((h) => this.toSearchResult(h, h.rank));
  }

  /**
   * 混合检索：向量 + 关键词，使用 Reciprocal Rank Fusion (RRF) 融合。
   * 公式：score(d) = Σ 1 / (k + rank_i(d))
   */
  async hybridSearch(options: HybridSearchOptions): Promise<SearchResult[]> {
    const {
      knowledgeBaseIds,
      query,
      topK = 5,
      rrfK = 60,
      embeddingModel,
    } = options;

    if (knowledgeBaseIds.length === 0 || !query.trim()) return [];

    const queryVector = await this.embed(
      query,
      embeddingModel,
      knowledgeBaseIds,
    );

    // 并发跑两路（多取一些给 RRF 融合）
    const [vectorResults, keywordResults] = await Promise.all([
      this.vectorStoreService.vectorSearch(
        knowledgeBaseIds,
        queryVector,
        topK * 4,
        1.0, // 融合阶段放宽阈值，让 RRF 有更多候选
      ),
      this.vectorStoreService.keywordSearch(knowledgeBaseIds, query, topK * 4),
    ]);

    // RRF 融合
    const scores = new Map<string, { result: SearchResult; score: number }>();

    const addHit = (hit: VectorHit | KeywordHit, rank: number) => {
      const fusedScore = 1 / (rrfK + rank + 1);
      const existing = scores.get(hit.chunkId);
      if (existing) {
        existing.score += fusedScore;
      } else {
        scores.set(hit.chunkId, {
          result: this.toSearchResult(hit, 0),
          score: fusedScore,
        });
      }
    };

    vectorResults.forEach((hit, rank) => addHit(hit, rank));
    keywordResults.forEach((hit, rank) => addHit(hit, rank));

    return [...scores.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ result, score }) => ({ ...result, score }));
  }

  // ---------------------------------------------------------------------------
  // 内部工具
  // ---------------------------------------------------------------------------

  /**
   * 生成查询向量。
   * model 优先用传入的（RAG 节点可指定 embeddingModel）；
   * 否则用知识库绑定的 embeddingModel（LLM 简单模式 / 默认场景）。
   */
  private async embed(
    query: string,
    model: string | undefined,
    knowledgeBaseIds: string[],
  ): Promise<number[]> {
    const embeddingModel =
      model ?? (await this.resolveEmbeddingModel(knowledgeBaseIds));
    const [vector] = await this.embeddingService.embedBatch(
      [query],
      embeddingModel,
    );
    return vector;
  }

  /** 解析知识库绑定的 embedding 模型（取第一个知识库） */
  private async resolveEmbeddingModel(
    knowledgeBaseIds: string[],
  ): Promise<string> {
    if (knowledgeBaseIds.length === 0) {
      return 'nomic-embed-text';
    }
    const kb = await this.prisma.knowledgeBase.findUnique({
      where: { id: knowledgeBaseIds[0] },
      select: { embeddingModel: true },
    });
    return kb?.embeddingModel ?? 'nomic-embed-text';
  }

  /** 将 VectorHit / KeywordHit 统一转换为 SearchResult */
  private toSearchResult(
    hit: VectorHit | KeywordHit,
    score: number,
  ): SearchResult {
    return {
      chunkId: hit.chunkId,
      documentId: hit.documentId,
      content: hit.content,
      score,
      metadata: (hit.metadata as Record<string, unknown> | null) ?? {},
      fileName: hit.fileName,
    };
  }
}
