import { Inject, Injectable } from '@nestjs/common';
import type {
  AiProvider,
  ChatMessage,
  ChatOptions,
  ChatResult,
  EmbeddingOptions,
  EmbeddingResult,
} from './ai-provider.interface';
import { AI_PROVIDER } from './ai-provider.interface';

@Injectable()
export class AIService {
  /** 默认 Embedding 模型，供知识库管线使用 */
  static readonly DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text';

  constructor(@Inject(AI_PROVIDER) private readonly provider: AiProvider) {}

  /** 多轮对话 */
  async chat(
    messages: ChatMessage[],
    options: ChatOptions,
  ): Promise<ChatResult> {
    return this.provider.chat(messages, options);
  }

  /** 单轮文本生成 */
  async complete(prompt: string, options: ChatOptions): Promise<ChatResult> {
    return this.provider.complete(prompt, options);
  }

  /** 流式对话 */
  streamChat(
    messages: ChatMessage[],
    options: ChatOptions,
  ): AsyncGenerator<string> {
    return this.provider.streamChat(messages, options);
  }

  /** 文本向量化 */
  async embedding(
    texts: string[],
    options: EmbeddingOptions,
  ): Promise<EmbeddingResult> {
    return this.provider.embedding(texts, options);
  }
}
