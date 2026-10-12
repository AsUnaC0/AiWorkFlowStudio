import { Inject, Injectable } from '@nestjs/common';
import type {
  AiProvider,
  ChatMessage,
  ChatOptions,
  ChatResult,
  EmbeddingOptions,
  EmbeddingResult,
  ModelCallTelemetry,
  ToolDefinition,
  ToolChatResult,
} from './ai-provider.interface';
import { AI_PROVIDER } from './ai-provider.interface';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AIService {
  /** 默认 Embedding 模型，供知识库管线使用 */
  static readonly DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text';

  constructor(
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * 暴露底层默认 Provider（默认是全局单例 Ollama）。
   * 供需要「自定义模型优先、否则回退默认」的调用方使用：
   *   const backend = customProvider ?? aiService.getProvider();
   */
  getProvider(): AiProvider {
    return this.provider;
  }

  /** 多轮对话 */
  async chat(
    messages: ChatMessage[],
    options: ChatOptions,
  ): Promise<ChatResult> {
    const start = Date.now();
    try {
      const res = await this.provider.chat(messages, options);
      await this.recordModelCall(options.telemetry, {
        model: res.model || options.model,
        callType: 'CHAT',
        promptTokens: res.usage?.promptTokens ?? 0,
        completionTokens: res.usage?.completionTokens ?? 0,
        totalTokens: res.usage?.totalTokens ?? 0,
        latencyMs: Date.now() - start,
        status: 'SUCCESS',
      });
      return res;
    } catch (e) {
      await this.recordModelCall(options.telemetry, {
        model: options.model,
        callType: 'CHAT',
        latencyMs: Date.now() - start,
        status: 'FAILED',
        errorCode: this.toErrorCode(e),
        errorMessage: this.toErrorMessage(e),
      });
      throw e;
    }
  }

  /** 单轮文本生成 */
  async complete(prompt: string, options: ChatOptions): Promise<ChatResult> {
    const start = Date.now();
    try {
      const res = await this.provider.complete(prompt, options);
      await this.recordModelCall(options.telemetry, {
        model: res.model || options.model,
        callType: 'CHAT',
        promptTokens: res.usage?.promptTokens ?? 0,
        completionTokens: res.usage?.completionTokens ?? 0,
        totalTokens: res.usage?.totalTokens ?? 0,
        latencyMs: Date.now() - start,
        status: 'SUCCESS',
      });
      return res;
    } catch (e) {
      await this.recordModelCall(options.telemetry, {
        model: options.model,
        callType: 'CHAT',
        latencyMs: Date.now() - start,
        status: 'FAILED',
        errorCode: this.toErrorCode(e),
        errorMessage: this.toErrorMessage(e),
      });
      throw e;
    }
  }

  /** 流式对话（流式无法可靠获取 usage，仅记录基础调用与错误） */
  async *streamChat(
    messages: ChatMessage[],
    options: ChatOptions,
  ): AsyncGenerator<string> {
    const start = Date.now();
    let failed = false;
    try {
      const gen = this.provider.streamChat(messages, options);
      for await (const chunk of gen) {
        yield chunk;
      }
    } catch (e) {
      failed = true;
      await this.recordModelCall(options.telemetry, {
        model: options.model,
        callType: 'CHAT',
        latencyMs: Date.now() - start,
        status: 'FAILED',
        errorCode: this.toErrorCode(e),
        errorMessage: this.toErrorMessage(e),
      });
      throw e;
    } finally {
      if (!failed) {
        await this.recordModelCall(options.telemetry, {
          model: options.model,
          callType: 'CHAT',
          latencyMs: Date.now() - start,
          status: 'SUCCESS',
        });
      }
    }
  }

  /** 文本向量化 */
  async embedding(
    texts: string[],
    options: EmbeddingOptions,
  ): Promise<EmbeddingResult> {
    const start = Date.now();
    try {
      const res = await this.provider.embedding(texts, options);
      await this.recordModelCall(options.telemetry, {
        model: res.model || options.model,
        callType: 'EMBEDDING',
        promptTokens: res.usage?.promptTokens ?? 0,
        totalTokens: res.usage?.totalTokens ?? 0,
        latencyMs: Date.now() - start,
        status: 'SUCCESS',
      });
      return res;
    } catch (e) {
      await this.recordModelCall(options.telemetry, {
        model: options.model,
        callType: 'EMBEDDING',
        latencyMs: Date.now() - start,
        status: 'FAILED',
        errorCode: this.toErrorCode(e),
        errorMessage: this.toErrorMessage(e),
      });
      throw e;
    }
  }

  /** 带工具的对话（Function Calling）—— Agent 核心入口 */
  async chatWithTools(
    messages: ChatMessage[],
    options: ChatOptions,
    tools: ToolDefinition[],
  ): Promise<ToolChatResult> {
    const start = Date.now();
    try {
      const res = await this.provider.chatWithTools(messages, options, tools);
      await this.recordModelCall(options.telemetry, {
        model: res.model || options.model,
        callType: 'CHAT',
        promptTokens: res.usage?.promptTokens ?? 0,
        completionTokens: res.usage?.completionTokens ?? 0,
        totalTokens: res.usage?.totalTokens ?? 0,
        latencyMs: Date.now() - start,
        status: 'SUCCESS',
      });
      return res;
    } catch (e) {
      await this.recordModelCall(options.telemetry, {
        model: options.model,
        callType: 'CHAT',
        latencyMs: Date.now() - start,
        status: 'FAILED',
        errorCode: this.toErrorCode(e),
        errorMessage: this.toErrorMessage(e),
      });
      throw e;
    }
  }

  // ===========================================================================
  // ModelCallLog 记录（fire-and-forget，绝不阻塞或影响主流程）
  // ===========================================================================
  async recordModelCall(
    telemetry: ModelCallTelemetry | undefined,
    meta: {
      model: string;
      callType: string;
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      latencyMs?: number;
      status: string;
      errorCode?: string;
      errorMessage?: string;
    },
  ): Promise<void> {
    if (!telemetry?.workspaceId) return; // 无归属上下文的调用不记录
    try {
      await this.prisma.modelCallLog.create({
        data: {
          workspaceId: telemetry.workspaceId!,
          workflowId: telemetry.workflowId,
          runId: telemetry.runId,
          nodeRunId: telemetry.nodeRunId,
          agentId: telemetry.agentId,
          provider: this.provider.name,
          model: meta.model,
          callType: meta.callType,
          promptTokens: meta.promptTokens ?? 0,
          completionTokens: meta.completionTokens ?? 0,
          totalTokens: meta.totalTokens ?? 0,
          latencyMs: meta.latencyMs,
          status: meta.status,
          errorCode: meta.errorCode,
          errorMessage: meta.errorMessage,
        },
      });
    } catch {
      /* 监控写入失败不影响业务 */
    }
  }

  private toErrorCode(e: unknown): string {
    if (e instanceof Error) {
      const msg = e.message.toLowerCase();
      if (msg.includes('timeout') || msg.includes('超时')) {
        return 'AI_PROVIDER_TIMEOUT';
      }
      if (msg.includes('rate') || msg.includes('429')) {
        return 'AI_PROVIDER_RATE_LIMIT';
      }
      if (msg.includes('unauthorized') || msg.includes('401') || msg.includes('api key')) {
        return 'AI_PROVIDER_AUTH';
      }
    }
    return 'AI_PROVIDER_ERROR';
  }

  private toErrorMessage(e: unknown): string {
    if (e instanceof Error) return e.message.slice(0, 500);
    return String(e).slice(0, 500);
  }
}
