import type { InjectionToken } from '@nestjs/common';

/** NestJS DI 注入令牌——用于绑定 AiProvider 接口到具体实现类 */
export const AI_PROVIDER: InjectionToken = Symbol('AI_PROVIDER');

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** function/tool 调用时：assistant 消息可带 tool_calls */
  tool_calls?: ToolCall[];
  /** tool 消息必填：对应哪个 call 的结果 */
  tool_call_id?: string;
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

// ===========================================================================
// Tool Calling（Function Calling）类型 —— 对齐 OpenAI / Ollama 协议
// ===========================================================================

/** 工具定义（传给 LLM 的 schema） */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters?: {
      type: 'object';
      properties: Record<
        string,
        {
          type: string;
          description?: string;
          enum?: string[];
          items?: Record<string, unknown>;
        }
      >;
      required?: string[];
    };
  };
}

/** LLM 返回的工具调用请求 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string，需 parse
  };
}

/** chatWithTools 的返回：可能有 content、可能有 tool_calls */
export interface ToolChatResult {
  content: string;
  toolCalls: ToolCall[];
  model: string;
  usage?: ChatResult['usage'];
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

  /**
   * 带工具的对话（Function Calling）。
   * 对齐 OpenAI / Ollama 协议：
   *  - LLM 决定调用哪些工具 → 返回 toolCalls
   *  - LLM 也可能直接回答 → 返回 content
   */
  chatWithTools(
    messages: ChatMessage[],
    options: ChatOptions,
    tools: ToolDefinition[],
  ): Promise<ToolChatResult>;
}
