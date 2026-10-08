import { Injectable } from '@nestjs/common';
import {
  NodeExecutor,
  NodeExecutionContext,
  NodeExecutionResult,
} from '../node-executor.interface';
import { VariableService } from '../variable.service';
import { KnowledgeRetrievalService } from '../../../knowledge/retrieval/knowledge-retrieval.service';
import type { SearchMode } from '../../../knowledge/retrieval/types';

export interface RagNodeConfig {
  /** 要检索的知识库 ID 列表 */
  knowledgeBaseIds: string[];
  /** 返回前 K 条，默认 5 */
  topK?: number;
  /**
   * 相似度阈值 0~1（越大越严格），低于则过滤掉。
   * 默认 0.2（对应距离 0.8，兼容旧的 distance 阈值语义）。
   */
  threshold?: number;
  /** 检索模式：vector / keyword / hybrid，默认 hybrid */
  searchMode?: SearchMode;
  /** embedding 模型名；不传则使用知识库绑定的 embeddingModel */
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
    private readonly knowledgeRetrievalService: KnowledgeRetrievalService,
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
    // threshold 在 config 里历史上是"距离阈值"（0.8 = 宽松），
    // KnowledgeRetrievalService.scoreThreshold 是"相似度阈值"（0.7 = 严格）。
    // 旧默认 0.8 距离 ≈ 0.2 相似度，保持兼容。
    const scoreThreshold = config.threshold ?? 0.2;
    const mode = config.searchMode ?? 'hybrid';
    const embeddingModel = config.embeddingModel;

    // ⭐ 统一走 KnowledgeRetrievalService（v1.4 共享检索服务）
    const results = await this.knowledgeRetrievalService.search({
      knowledgeBaseIds: kbIds,
      query,
      topK,
      scoreThreshold,
      mode,
      embeddingModel,
    });

    console.log(
      '[RAG] 检索完成，命中',
      results.length,
      '条，模式:',
      mode,
    );

    if (config.outputFormat === 'json') {
      return {
        output: {
          query,
          hits: results.map((r) => ({
            chunkId: r.chunkId,
            documentId: r.documentId,
            content: r.content,
            score: r.score,
            metadata: r.metadata,
            fileName: r.fileName,
          })),
        },
      };
    }

    // 默认输出纯文本，明确区分【问题】和【知识库参考】，下游 LLM 节点才能正确理解
    const contextBlock =
      results.length > 0
        ? results
            .map(
              (r, i) =>
                `[${i + 1}]${r.fileName ? ` 来源：${r.fileName}` : ''}\n${r.content}`,
            )
            .join('\n\n')
        : '（未检索到相关内容）';

    const text = `【问题】\n${query}\n\n【知识库参考】\n${contextBlock}`;

    console.log('[RAG] 最终输出长度 =', text.length, '字符');
    return { output: text };
  }
}
