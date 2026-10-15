import { Injectable } from '@nestjs/common';
import { AIService } from '../../ai/ai.service';
import type {
  AiProvider,
  EmbeddingOptions,
  EmbeddingResult,
  ModelCallTelemetry,
} from '../../ai/ai-provider.interface';
import { LlmConfigService } from '../../llm-config/llm-config.service';
import { toErrorCode } from '../../common/error-code.util';

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
   * @param telemetry  监控遥测上下文；传入时每次批量调用都会写入 ModelCallLog，
   *                   让仪表盘能看到云端 Embedding 模型的真实消耗。
   */
  async embedBatch(
    texts: string[],
    model: string,
    llmModelId?: string | null,
    telemetry?: ModelCallTelemetry,
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
      const start = Date.now();
      try {
        const result: EmbeddingResult = await backend.embedding(batch, options);
        allVectors.push(...result.embeddings);
        await this.recordEmbeddingCall(telemetry, backend, {
          model: result.model || modelName,
          promptTokens: result.usage?.promptTokens ?? 0,
          totalTokens: result.usage?.totalTokens ?? 0,
          latencyMs: Date.now() - start,
          status: 'SUCCESS',
        });
      } catch (e) {
        await this.recordEmbeddingCall(telemetry, backend, {
          model: modelName,
          latencyMs: Date.now() - start,
          status: 'FAILED',
          errorCode: toErrorCode(e),
          errorMessage: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }
    }

    return allVectors;
  }

  /**
   * 记录 Embedding 调用（fire-and-forget，失败不影响向量化主流程）。
   * 必须显式带上 backend.name —— 云端 Embedding 走的是动态构造的 Provider，
   * 否则会被错误归属到默认的本地 Ollama。
   */
  private async recordEmbeddingCall(
    telemetry: ModelCallTelemetry | undefined,
    backend: AiProvider,
    meta: {
      model: string;
      promptTokens?: number;
      totalTokens?: number;
      latencyMs?: number;
      status: 'SUCCESS' | 'FAILED';
      errorCode?: string;
      errorMessage?: string;
    },
  ): Promise<void> {
    await this.aiService.recordModelCall(telemetry, {
      ...meta,
      callType: 'EMBEDDING',
      provider: backend.name,
    });
  }
}
