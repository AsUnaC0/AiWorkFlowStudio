import { Injectable } from '@nestjs/common';
import {
  AiProvider,
  ChatMessage,
  ChatOptions,
  ChatResult,
  EmbeddingOptions,
  EmbeddingResult,
  ToolDefinition,
  ToolCall,
  ToolChatResult,
} from '../ai-provider.interface';

const OLLAMA_BASE_URL = 'http://localhost:11434';

@Injectable()
export class OllamaProvider implements AiProvider {
  readonly name = 'ollama';

  // ---------------------------------------------------------------------------
  // Chat（多轮，完整实现）
  // ---------------------------------------------------------------------------

  async chat(
    messages: ChatMessage[],
    options: ChatOptions,
  ): Promise<ChatResult> {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        messages,
        stream: false,
        options: this.buildOllamaOptions(options),
      }),
    });

    if (!response.ok) {
      throw new Error(await this.buildError(response));
    }

    const data = (await response.json()) as {
      message?: { content?: string };
      eval_count?: number;
      prompt_eval_count?: number;
    };

    const content = data.message?.content ?? '';
    const promptTokens = data.prompt_eval_count;
    const completionTokens = data.eval_count;

    return {
      content,
      model: options.model,
      usage:
        promptTokens !== undefined && completionTokens !== undefined
          ? {
              promptTokens,
              completionTokens,
              totalTokens: promptTokens + completionTokens,
            }
          : undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // Complete（单轮，委托给 chat）
  // ---------------------------------------------------------------------------

  async complete(prompt: string, options: ChatOptions): Promise<ChatResult> {
    return this.chat([{ role: 'user', content: prompt }], options);
  }

  // ---------------------------------------------------------------------------
  // Stream（流式，完整实现）
  // ---------------------------------------------------------------------------

  async *streamChat(
    messages: ChatMessage[],
    options: ChatOptions,
  ): AsyncGenerator<string> {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        messages,
        stream: true,
        options: this.buildOllamaOptions(options),
      }),
    });

    if (!response.ok || !response.body) {
      throw new Error(await this.buildError(response));
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          const data = JSON.parse(line) as {
            message?: { content?: string };
            done?: boolean;
          };
          const content = data.message?.content;
          if (content) yield content;
        }

        if (done) break;
      }
    } finally {
      reader.releaseLock();
    }
  }

  // ---------------------------------------------------------------------------
  // Embedding（向量）
  // ---------------------------------------------------------------------------

  async embedding(
    texts: string[],
    options: EmbeddingOptions,
  ): Promise<EmbeddingResult> {
    const embeddings: number[][] = [];

    for (const text of texts) {
      const response = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options.model,
          prompt: text,
        }),
      });

      if (!response.ok) {
        throw new Error(await this.buildError(response));
      }

      const data = (await response.json()) as { embedding: number[] };
      embeddings.push(data.embedding);
    }

    return { embeddings, model: options.model };
  }

  // ---------------------------------------------------------------------------
  // Tool Calling（Function Calling）
  // ---------------------------------------------------------------------------

  async chatWithTools(
    messages: ChatMessage[],
    options: ChatOptions,
    tools: ToolDefinition[],
  ): Promise<ToolChatResult> {
    // Ollama 0.3.0+ 的 /api/chat 支持 tools 参数
    // 把 ToolDefinition（OpenAI schema）直接透传给 Ollama —— Ollama 兼容同构 schema
    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        messages: this.toOllamaMessages(messages),
        stream: false,
        tools,
        options: this.buildOllamaOptions(options),
      }),
    });

    if (!response.ok) {
      throw new Error(await this.buildError(response));
    }

    const data = (await response.json()) as {
      message?: {
        content?: string;
        tool_calls?: Array<{
          id?: string;
          type: 'function';
          function: { name: string; arguments: string };
        }>;
      };
      eval_count?: number;
      prompt_eval_count?: number;
    };

    // 解析 tool_calls
    const rawCalls = data.message?.tool_calls ?? [];
    const toolCalls: ToolCall[] = rawCalls.map((c, i) => ({
      id: c.id ?? `call_${i}_${Date.now()}`,
      type: 'function',
      function: {
        name: c.function.name,
        arguments: c.function.arguments ?? '{}',
      },
    }));

    return {
      content: data.message?.content ?? '',
      toolCalls,
      model: options.model,
      usage:
        data.prompt_eval_count !== undefined && data.eval_count !== undefined
          ? {
              promptTokens: data.prompt_eval_count,
              completionTokens: data.eval_count,
              totalTokens: data.prompt_eval_count + data.eval_count,
            }
          : undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // 内部工具
  // ---------------------------------------------------------------------------

  /**
   * 把 ChatMessage（含 tool role / tool_calls）转换成 Ollama 能接受的格式。
   * Ollama 0.3+ 支持 tool role + tool_calls，schema 与 OpenAI 基本一致。
   */
  private toOllamaMessages(messages: ChatMessage[]): unknown[] {
    return messages.map((m) => {
      const base: Record<string, unknown> = {
        role: m.role,
        content: m.content,
      };
      if (m.tool_calls && m.tool_calls.length > 0) {
        base.tool_calls = m.tool_calls.map((tc) => ({
          id: tc.id,
          type: tc.type,
          function: tc.function,
        }));
      }
      if (m.tool_call_id) {
        base.tool_call_id = m.tool_call_id;
      }
      return base;
    });
  }

  private buildOllamaOptions(options: ChatOptions): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    if (options.temperature !== undefined)
      result.temperature = options.temperature;
    if (options.maxTokens !== undefined) result.num_predict = options.maxTokens;
    return result;
  }

  private async buildError(response: Response): Promise<string> {
    const body = await response.text();
    return `Ollama 请求失败: ${response.status}${body ? ` - ${body}` : ''}`;
  }
}
