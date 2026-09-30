import { Injectable } from '@nestjs/common';
import {
  NodeExecutor,
  NodeExecutionContext,
  NodeExecutionResult,
} from '../node-executor.interface';
import { VariableService } from '../variable.service';
import { EmbeddingService } from '../../../knowledge/embedding/embedding.service';
import { VectorStoreService } from '../../../knowledge/vector/vector-store.service';

export interface RagNodeConfig {
  /** 要检索的知识库 ID 列表 */
  knowledgeBaseIds: string[];
  /** 返回前 K 条，默认 5 */
  topK?: number;
  /** 向量检索距离阈值，默认 0.8 */
  threshold?: number;
  /** 检索模式：vector / keyword / hybrid，默认 hybrid */
  searchMode?: 'vector' | 'keyword' | 'hybrid';
  /** embedding 模型名 */
  embeddingModel?: string;
  /** 输出格式：text（纯文本拼接）/ json（结构化），默认 text */
  outputFormat?: 'text' | 'json';
  /**
   * 检索 query 模板，支持 {{变量}} 引用
   * 如果未设置或为空，则使用 previousOutput
   * 例："请根据 {{input}} 检索相关内容" 或 "{{http_1.body.query}}"
   */
  queryTemplate?: string;
}

@Injectable()
export class RAGNodeExecutor implements NodeExecutor {
  constructor(
    private readonly variableService: VariableService,
    private readonly embeddingService: EmbeddingService,
    private readonly vectorStoreService: VectorStoreService,
  ) {}

  async execute(
    context: NodeExecutionContext,
    node: any,
  ): Promise<NodeExecutionResult> {
    const config = (node.config ?? {}) as RagNodeConfig;

    // query 来源：优先用 queryTemplate（支持变量），否则用 previousOutput
    let query: string;
    if (config.queryTemplate && config.queryTemplate.trim()) {
      // 用户配置了 query 模板 → 通过变量服务解析
      query = String(
        this.variableService.resolve(config.queryTemplate, context) ?? '',
      ).trim();
    } else {
      // 未配置模板 → 传统行为：用上一个节点输出
      query = String(
        context.previousOutput ?? context.input ?? '',
      ).trim();
    }

    console.log('[RAG] node.config =', JSON.stringify(config, null, 2));
    console.log('[RAG] query =', JSON.stringify(query));

    if (!query) {
      console.log('[RAG] query 为空，跳过检索');
      return { output: '' };
    }

    const kbIds = config.knowledgeBaseIds ?? [];
    if (kbIds.length === 0) {
      console.log(
        '[RAG] knowledgeBaseIds 为空，跳过检索 — 请在前端属性面板选择至少一个知识库',
      );
      // 虽然没检索，但仍把 query 透传给下游，让 LLM 能回答
      return { output: query };
    }

    const topK = config.topK ?? 5;
    const threshold = config.threshold ?? 0.8;
    const mode = config.searchMode ?? 'hybrid';
    const model = config.embeddingModel ?? 'nomic-embed-text';

    let hits: Array<{
      content: string;
      score?: number;
      distance?: number;
      chunkId: string;
    }> = [];

    if (mode === 'keyword') {
      const keywordHits = await this.vectorStoreService.keywordSearch(
        kbIds,
        query,
        topK,
      );
      hits = keywordHits.map((h) => ({
        chunkId: h.chunkId,
        content: h.content,
        score: h.rank,
      }));
      console.log('keywordHits', hits);
    } else {
      // vector / hybrid 都需要 query embedding
      const [queryVector] = await this.embeddingService.embedBatch(
        [query],
        model,
      );

      if (mode === 'vector') {
        const vectorHits = await this.vectorStoreService.vectorSearch(
          kbIds,
          queryVector,
          topK,
          threshold,
        );
        hits = vectorHits.map((h) => ({
          chunkId: h.chunkId,
          content: h.content,
          distance: h.distance,
        }));
        console.log('vectorHits', hits);
      } else {
        const hybridHits = await this.vectorStoreService.hybridSearch(
          kbIds,
          query,
          queryVector,
          topK,
        );
        hits = hybridHits.map((h) => ({
          chunkId: h.chunkId,
          content: h.content,
          score: h.score,
        }));
        console.log('hybridHits', hits);
      }
    }

    if (config.outputFormat === 'json') {
      return { output: { query, hits } };
    }

    // 默认输出纯文本，明确区分【问题】和【知识库参考】，下游 LLM 节点才能正确理解
    const contextBlock =
      hits.length > 0
        ? hits.map((h, i) => `[${i + 1}] ${h.content}`).join('\n\n')
        : '（未检索到相关内容）';

    const text = `【问题】\n${query}\n\n【知识库参考】\n${contextBlock}`;

    console.log('[RAG] 最终输出长度 =', text.length, '字符');
    return { output: text };
  }
}
