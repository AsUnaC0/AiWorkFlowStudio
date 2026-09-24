import { Injectable } from '@nestjs/common';
import { AIService } from '../../ai/ai.service';
import type {
  EmbeddingOptions,
  EmbeddingResult,
} from '../../ai/ai-provider.interface';

/** 单批最大条数（避免单次 Ollama 调用过大） */
const BATCH_SIZE = 100;

@Injectable()
export class EmbeddingService {
  constructor(private readonly aiService: AIService) {}

  /** 批量文本向量化（内部自动按 BATCH_SIZE 分批调 Ollama） */
  async embedBatch(texts: string[], model: string): Promise<number[][]> {
    if (texts.length === 0) return [];

    const options: EmbeddingOptions = { model };
    const allVectors: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const result: EmbeddingResult = await this.aiService.embedding(
        batch,
        options,
      );
      allVectors.push(...result.embeddings);
    }

    return allVectors;
  }
}
