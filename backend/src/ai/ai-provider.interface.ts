import type { InjectionToken } from '@nestjs/common';

/** NestJS DI 注入令牌——用于绑定 AiProvider 接口到具体实现类 */
export const AI_PROVIDER: InjectionToken = Symbol('AI_PROVIDER');

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatResult {
  content: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface EmbeddingOptions {
  model: string;
}

export interface EmbeddingResult {
  embeddings: number[][];
  model: string;
  usage?: {
    promptTokens?: number;
    totalTokens?: number;
  };
}

export interface AiProvider {
  /** Provider 名称，用于日志和调试 */
  readonly name: string;

  /** 单轮文本生成 */
  complete(prompt: string, options: ChatOptions): Promise<ChatResult>;

  /** 多轮对话 */
  chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult>;

  /** 流式对话 */
  streamChat(
    messages: ChatMessage[],
    options: ChatOptions,
  ): AsyncGenerator<string>;

  /** 文本向量化 */
  embedding(
    texts: string[],
    options: EmbeddingOptions,
  ): Promise<EmbeddingResult>;
}
