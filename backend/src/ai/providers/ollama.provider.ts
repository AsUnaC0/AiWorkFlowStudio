import { Injectable, Inject, Optional } from '@nestjs/common';
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
import { stringifyToolArguments, parseToolArguments } from '../tool-args.util';
import { normalizeContentToString } from '../content.util';

const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';

@Injectable()
export class OllamaProvider implements AiProvider {
  readonly name = 'ollama';

  private readonly baseUrl: string;

  /**
   * @param baseUrl 可选。不传则使用默认本地地址（与现有 AIService 行为一致）。
   * 模型管理功能创建自定义 Ollama 配置时可传入内网/远程地址。
   * 标记 @Optional/@Inject 是为了不影响现有通过 DI 注入的 AIService（不传参）。
   */
  constructor(
    @Optional()
    @Inject('LLM_OLLAMA_BASE_URL')
    baseUrl?: string,
  ) {
    this.baseUrl = baseUrl || DEFAULT_OLLAMA_BASE_URL;
  }

  // ---------------------------------------------------------------------------
  // Chat（多轮，完整实现）
  // ---------------------------------------------------------------------------

  async chat(
    messages: ChatMessage[],
    options: ChatOptions,
  ): Promise<ChatResult> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        // 必须走 toOllamaMessages：含 tool_calls 的历史消息需要把 arguments 转回对象
        messages: this.toOllamaMessages(messages),
        stream: false,
        options: this.buildOllamaOptions(options),
      }),
    });

    if (!response.ok) {
      throw new Error(await this.buildError(response));
    }

    const data = (await response.json()) as {
      message?: { content?: unknown };
      eval_count?: number;
      prompt_eval_count?: number;
    };

    const content = normalizeContentToString(data.message?.content);
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
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        // 同 chat：含 tool_calls 的消息需把 arguments 转回对象，否则 Ollama 解析报错
        messages: this.toOllamaMessages(messages),
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
            message?: { content?: unknown };
            done?: boolean;
          };
          const content = data.message?.content;
          if (content != null) {
            const text = normalizeContentToString(content);
            if (text) yield text;
          }
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
      const response = await fetch(`${this.baseUrl}/api/embeddings`, {
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
    const response = await fetch(`${this.baseUrl}/api/chat`, {
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
        content?: unknown;
        tool_calls?: Array<{
          id?: string;
          type: 'function';
          // 兼容部分实现把 arguments 返回成对象的情况
          function: { name: string; arguments: unknown };
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
        arguments: stringifyToolArguments(c.function.arguments),
      },
    }));

    return {
      content: normalizeContentToString(data.message?.content),
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
      // 视觉输入：Ollama 在 user 消息上挂 images（base64 字符串数组）
      if (m.role === 'user' && m.images && m.images.length > 0) {
        base.images = m.images.map((img) => img.base64);
      }
      if (m.tool_calls && m.tool_calls.length > 0) {
        base.tool_calls = m.tool_calls.map((tc) => ({
          id: tc.id,
          type: tc.type,
          function: {
            name: tc.function.name,
            // 注意：Ollama 的 tool_calls.function.arguments 要求是「对象」，
            // 而内部统一按 OpenAI 规范存成 JSON 字符串，这里需转回对象，
            // 否则 Ollama 解析会报 `Value looks like object, but can't find closing '}' symbol`。
            arguments: parseToolArguments(tc.function.arguments),
          },
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

  /** 列出本地 Ollama 已拉取的模型（连接测试 / 模型发现用） */
  async listModels(): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/api/tags`, {
      method: 'GET',
    });

    if (!response.ok) {
      throw new Error(await this.buildError(response));
    }

    const data = (await response.json()) as {
      models?: Array<{ name?: string }>;
    };
    return (data.models ?? [])
      .map((m) => m.name)
      .filter((name): name is string => typeof name === 'string');
  }
}
