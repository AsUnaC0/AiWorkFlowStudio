import { Injectable } from '@nestjs/common';
import {
  AiProvider,
  ChatMessage,
  ChatOptions,
  ChatResult,
  EmbeddingOptions,
  EmbeddingResult,
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
  // 内部工具
  // ---------------------------------------------------------------------------

  private buildOllamaOptions(options: ChatOptions): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    if (options.temperature !== undefined) result.temperature = options.temperature;
    if (options.maxTokens !== undefined) result.num_predict = options.maxTokens;
    return result;
  }

  private async buildError(response: Response): Promise<string> {
    const body = await response.text();
    return `Ollama 请求失败: ${response.status}${body ? ` - ${body}` : ''}`;
  }
}
