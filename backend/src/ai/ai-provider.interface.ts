export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  model?: string;
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

export interface AiProvider {
  /** Provider 名称，用于日志和调试 */
  readonly name: string;

  /** 发送单轮提示词 */
  complete(prompt: string, options?: ChatOptions): Promise<ChatResult>;

  /** 发送多轮对话消息 */
  chat(params: {
    model: string;
    messages: {
      role: 'system' | 'user' | 'assistant';
      content: string;
    }[];
  }): Promise<string>;
}
