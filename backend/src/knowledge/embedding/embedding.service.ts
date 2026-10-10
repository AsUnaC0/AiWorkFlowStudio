import { Injectable } from '@nestjs/common';
import { AIService } from '../../ai/ai.service';
import type {
  AiProvider,
  EmbeddingOptions,
  EmbeddingResult,
} from '../../ai/ai-provider.interface';
import { LlmConfigService } from '../../llm-config/llm-config.service';

/** 单批最大条数（避免单次 Ollama 调用过大） */
const BATCH_SIZE = 100;

@Injectable()
export class EmbeddingService {
  constructor(
    private readonly aiService: AIService,
    private readonly llmConfigService: LlmConfigService,
  ) {}

  /**
   * 批量文本向量化（内部自动按 BATCH_SIZE 分批）。
   *
   * @param model      Ollama 本地 embedding 模型名（未指定 llmModelId 时使用）
   * @param llmModelId 用户在「模型管理」中添加的 Embedding 模型 id；
   *                   传入时优先用它解析 Provider（支持云端 embedding），否则回退全局 Ollama。
   */
  async embedBatch(
    texts: string[],
    model: string,
    llmModelId?: string | null,
  ): Promise<number[][]> {
    if (texts.length === 0) return [];

    let backend: AiProvider = this.aiService.getProvider();
    let modelName = model;
    if (llmModelId) {
      const runtime =
        await this.llmConfigService.resolveModelRuntime(llmModelId);
      backend = runtime.provider;
      modelName = runtime.modelId;
    }

    const options: EmbeddingOptions = { model: modelName };
    const allVectors: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const result: EmbeddingResult = await backend.embedding(batch, options);
      allVectors.push(...result.embeddings);
    }

    return allVectors;
  }
}
