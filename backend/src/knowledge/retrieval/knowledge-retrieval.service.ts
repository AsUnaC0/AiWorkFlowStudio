import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { EmbeddingVersionService } from '../embedding/embedding-version.service';
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
  private readonly logger = new Logger(KnowledgeRetrievalService.name);

  constructor(
    private readonly vectorStoreService: VectorStoreService,
    private readonly embeddingService: EmbeddingService,
    private readonly prisma: PrismaService,
    private readonly versionService: EmbeddingVersionService,
  ) {}

  /**
   * 通用检索入口，根据 mode 自动路由到对应实现。
   * 默认 hybrid（先做关键词兜底，再做向量精排）。
   */
  async search(options: SearchOptions): Promise<SearchResult[]> {
    const mode = options.mode ?? 'hybrid';

    switch (mode) {
      case 'vector': {
        // 查询向量按各知识库激活版本的模型分别生成（保证与库中向量同模型同维度）
        const topK = options.topK ?? 5;
        const distanceThreshold =
          options.scoreThreshold != null ? 1 - options.scoreThreshold : 0.8;
        const hits = await this.searchForQuery(
          options.query,
          options.knowledgeBaseIds,
          options.embeddingModel,
          options.telemetry,
          topK,
        );
        return hits
          .filter((h) => h.distance <= distanceThreshold)
          .map((h) => this.toSearchResult(h, 1 - h.distance));
      }

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
          telemetry: options.telemetry,
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

    // 已传入查询向量（旧调用方式）：按各知识库激活版本的维度挑选可用的版本表
    if (queryVector?.length) {
      const hits = await this.searchAcrossActiveVersions(
        knowledgeBaseIds,
        queryVector,
        topK,
        distanceThreshold,
      );
      return hits.map((h) => this.toSearchResult(h, 1 - h.distance));
    }

    const hits = await this.vectorStoreService.vectorSearch(
      knowledgeBaseIds,
      queryVector,
      topK,
      distanceThreshold,
    );

    // score 统一为相似度语义（越大越好）：相似度 = 1 - 余弦距离
    return hits.map((h) => this.toSearchResult(h, 1 - h.distance));
  }

  /**
   * 按「激活向量版本」检索。
   *
   * 不同知识库可能用不同模型 / 维度，因此必须逐个知识库取其激活版本表来查，
   * 查询向量的维度也要与对应版本一致（由 searchForQuery 保证每个 kb 单独向量化）。
   */
  private async searchAcrossActiveVersions(
    knowledgeBaseIds: string[],
    queryVector: number[],
    topK: number,
    distanceThreshold: number,
  ): Promise<VectorHit[]> {
    const versions = await this.prisma.knowledgeBaseEmbeddingVersion.findMany({
      where: {
        knowledgeBaseId: { in: knowledgeBaseIds },
        isActive: true,
      },
      select: { id: true, knowledgeBaseId: true, vectorTable: true, dimensions: true },
    });

    const usable = versions.filter(
      (v) => v.dimensions === queryVector.length && v.vectorTable,
    );
    if (usable.length === 0) return [];

    const perTable = Math.max(topK, Math.ceil(topK / usable.length) + topK);
    const results = await Promise.all(
      usable.map((v) =>
        this.vectorStoreService
          .vectorSearchInTable(
            v.vectorTable,
            [v.knowledgeBaseId],
            queryVector,
            perTable,
            distanceThreshold,
          )
          .catch((err) => {
            this.logger.warn(
              `向量检索失败（版本 ${v.id}，表 ${v.vectorTable}）：${
                err instanceof Error ? err.message : err
              }`,
            );
            return [] as VectorHit[];
          }),
      ),
    );

    return results
      .flat()
      .sort((a, b) => a.distance - b.distance)
      .slice(0, topK);
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
      telemetry,
    } = options;

    if (knowledgeBaseIds.length === 0 || !query.trim()) return [];

    // 并发跑两路（多取一些给 RRF 融合）
    const [vectorResults, keywordResults] = await Promise.all([
      this.searchForQuery(
        query,
        knowledgeBaseIds,
        embeddingModel,
        telemetry,
        topK * 4,
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
   * 按「各知识库激活版本」生成查询向量并检索。
   *
   * ⚠️ 关键：查询向量必须与库里存的向量来自同一模型 / 同一维度。
   * 因此不能拿一个全局模型给所有知识库向量化 —— 逐个知识库用各自激活版本的模型生成。
   */
  private async searchForQuery(
    query: string,
    knowledgeBaseIds: string[],
    explicitModel?: string,
    telemetry?: import('../../ai/ai-provider.interface').ModelCallTelemetry,
    topK = 20,
  ): Promise<VectorHit[]> {
    const versions =
      await this.prisma.knowledgeBaseEmbeddingVersion.findMany({
        where: { knowledgeBaseId: { in: knowledgeBaseIds }, isActive: true },
        select: {
          id: true,
          knowledgeBaseId: true,
          modelId: true,
          llmModelId: true,
          dimensions: true,
          vectorTable: true,
        },
      });

    // 兼容回退：尚未建立向量版本时，沿用旧的 DocumentChunk.embedding 列
    if (versions.length === 0) {
      const fallbackVector = await this.embed(
        query,
        explicitModel,
        knowledgeBaseIds,
        telemetry,
      );
      return this.vectorStoreService.vectorSearch(
        knowledgeBaseIds,
        fallbackVector,
        topK,
        1.0,
      );
    }

    const buckets = await Promise.all(
      versions.map(async (v) => {
        if (!v.vectorTable) return [] as VectorHit[];
        try {
          const [vector] = await this.embeddingService.embedBatch(
            [query],
            explicitModel ?? v.modelId,
            explicitModel ? null : v.llmModelId,
            telemetry,
          );
          if (!vector) return [] as VectorHit[];
          if (vector.length !== v.dimensions) {
            this.logger.warn(
              `查询向量维度 ${vector.length} 与版本 ${v.id} 的 ${v.dimensions} 维不一致，已跳过该知识库`,
            );
            return [] as VectorHit[];
          }
          return await this.vectorStoreService.vectorSearchInTable(
            v.vectorTable,
            [v.knowledgeBaseId],
            vector,
            topK,
            1.0,
          );
        } catch (err) {
          this.logger.warn(
            `查询向量化失败（版本 ${v.id}）：${
              err instanceof Error ? err.message : err
            }`,
          );
          return [] as VectorHit[];
        }
      }),
    );

    return buckets
      .flat()
      .sort((a, b) => a.distance - b.distance)
      .slice(0, topK);
  }

  /**
   * 生成查询向量（兼容旧路径：无向量版本时使用）。
   * model 优先用传入的（RAG 节点可指定 embeddingModel）；
   * 否则用知识库绑定的 embeddingModel（LLM 简单模式 / 默认场景）。
   */
  private async embed(
    query: string,
    model: string | undefined,
    knowledgeBaseIds: string[],
    telemetry?: import('../../ai/ai-provider.interface').ModelCallTelemetry,
  ): Promise<number[]> {
    const resolved = await this.resolveEmbedding(model, knowledgeBaseIds);
    const [vector] = await this.embeddingService.embedBatch(
      [query],
      resolved.model,
      resolved.llmModelId,
      telemetry,
    );
    return vector;
  }

  /**
   * 解析用于「查询向量化」的 embedding 模型（必须与文档入库时所用模型一致）：
   *   - 显式传入 model（Ollama 模型名）时优先用它；
   *   - 否则取第一个知识库绑定的模型：自定义 Embedding 模型 id 优先，回退本地 embeddingModel 名。
   */
  private async resolveEmbedding(
    model: string | undefined,
    knowledgeBaseIds: string[],
  ): Promise<{ model: string; llmModelId: string | null }> {
    if (model) return { model, llmModelId: null };
    if (knowledgeBaseIds.length === 0) {
      return { model: 'nomic-embed-text', llmModelId: null };
    }
    const kb = await this.prisma.knowledgeBase.findUnique({
      where: { id: knowledgeBaseIds[0] },
      select: { embeddingModel: true, embeddingLlmModelId: true },
    });
    return {
      model: kb?.embeddingModel ?? 'nomic-embed-text',
      llmModelId: kb?.embeddingLlmModelId ?? null,
    };
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
