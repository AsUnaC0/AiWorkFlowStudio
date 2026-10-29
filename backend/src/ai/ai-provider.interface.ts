import type { InjectionToken } from '@nestjs/common';

/** NestJS DI 注入令牌——用于绑定 AiProvider 接口到具体实现类 */
export const AI_PROVIDER: InjectionToken = Symbol('AI_PROVIDER');

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** 图片输入（视觉模型用，base64，不含 data: 前缀） */
export interface ChatImage {
  mimeType: string;
  base64: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** 图片输入：当前仅 user 消息 + 支持视觉输入的模型会用到 */
  images?: ChatImage[];
  /** function/tool 调用时：assistant 消息可带 tool_calls */
  tool_calls?: ToolCall[];
  /** tool 消息必填：对应哪个 call 的结果 */
  tool_call_id?: string;
}

export interface ChatOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** 监控遥测上下文：由调用方（Agent / 工作流引擎）传入，用于归属模型调用记录 */
  telemetry?: ModelCallTelemetry;
}

/** 模型调用遥测上下文 —— 用于 ModelCallLog 归属与权限隔离 */
export interface ModelCallTelemetry {
  workspaceId?: string;
  workflowId?: string;
  runId?: string;
  nodeRunId?: string;
  agentId?: string;
}

export interface ChatResult {
  content: string;
  /**
   * 推理过程（思维链），可选。
   *
   * 只有「思考型模型」才会返回：DeepSeek reasoner 的 `reasoning_content`、
   * OpenRouter 等网关的 `reasoning`、Ollama thinking 模型的 `message.thinking`。
   * 普通模型为 undefined —— 调用方必须容忍缺失。
   */
  reasoning?: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * 流式分片 —— 一次流式响应里可能同时存在两条通道。
 *
 * - `content`   给用户看的正文，会拼进聊天气泡、写进 ChatMessage.content
 * - `reasoning` 模型的推理过程，只展示在独立的折叠区，**不能**混进正文
 *
 * 之所以做成联合类型而不是「正文里加标记」：推理内容一旦混进 content，
 * 就会被持久化进聊天记录、被工作流节点当成输出、被桌宠念出来，全都是错的。
 * 拆成两条通道后，每个消费方自己决定要不要处理 reasoning。
 */
export type ChatStreamChunk =
  | { type: 'content'; text: string }
  | { type: 'reasoning'; text: string };

/**
 * 只取正文的便捷迭代器。
 *
 * 不关心推理过程的调用方（工作流 LLM 节点、AIService 旧接口等）用它包一层，
 * 就能把 `AsyncGenerator<ChatStreamChunk>` 降级成 `AsyncGenerator<string>`。
 */
export async function* contentOnly(
  source: AsyncIterable<ChatStreamChunk>,
): AsyncGenerator<string> {
  for await (const chunk of source) {
    if (chunk.type === 'content') yield chunk.text;
  }
}

export interface EmbeddingOptions {
  model: string;
  /** 监控遥测上下文（知识库管线传入，用于归属 Embedding 调用） */
  telemetry?: ModelCallTelemetry;
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
  /** 推理过程（同 ChatResult.reasoning，思考型模型才有） */
  reasoning?: string;
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

  /**
   * 流式对话。
   *
   * 返回的是「分片」而非纯字符串：正文与推理过程走两条通道，
   * 消费方按 `chunk.type` 分别处理（只要正文就套 `contentOnly()`）。
   */
  streamChat(
    messages: ChatMessage[],
    options: ChatOptions,
  ): AsyncGenerator<ChatStreamChunk>;

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

  /**
   * 列出该端点支持的模型 ID（连接测试 / 模型发现用）。
   * 非所有 Provider 都实现；未实现则返回空数组。
   */
  listModels?(): Promise<string[]>;
}
