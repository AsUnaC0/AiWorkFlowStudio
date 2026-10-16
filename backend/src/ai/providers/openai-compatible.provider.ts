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
import { stringifyToolArguments } from '../tool-args.util';
import { normalizeContentToString } from '../content.util';

/**
 * OpenAI 兼容 Provider —— 覆盖 OpenAI 官方、DeepSeek、以及任意 OpenAI 兼容网关。
 *
 * 通过 `baseUrl` + `apiKey` 构造，所有请求走标准 OpenAI 协议：
 *   - 对话：POST `{baseUrl}/chat/completions`
 *   - 流式：同上，SSE（`data: {...}` 逐行，以 `data: [DONE]` 结束）
 *   - 向量：POST `{baseUrl}/embeddings`
 *   - 工具：POST `{baseUrl}/chat/completions`，透传 tools
 *   - 模型列表：GET `{baseUrl}/models`
 *
 * 注意：Ollama 用的是 NDJSON，而 OpenAI 是 SSE，二者行解析逻辑不同，因此单独实现。
 */
export class OpenAICompatibleProvider implements AiProvider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  /**
   * @param baseUrl API 根地址，例如 `https://api.openai.com/v1`。
   *                 即使误填了完整接口路径（如 `…/v1/chat/completions` 或 `…/v1/models`），
   *                 构造函数也会自动归一化为根地址，避免后端重复拼接 `/chat/completions`、`/models` 等。
   * @param apiKey  Bearer Token
   * @param name    标识名（默认 openai-compatible）
   */
  constructor(baseUrl: string, apiKey?: string, name = 'openai-compatible') {
    this.baseUrl = OpenAICompatibleProvider.normalizeBaseUrl(baseUrl);
    this.apiKey = apiKey;
    this.name = name;
  }

  /**
   * 归一化 API 根地址：
   *  - 去除首尾空白与末尾多余的 `/`；
   *  - 若用户误把完整接口路径当作 baseUrl（常见于复制“聊天接口”或“模型列表”URL），
   *    自动剥离已知的 OpenAI 协议叶子接口后缀，保留到 API 根（含 `/v1`/`/v4` 等版本前缀）。
   *
   * 这样无论用户填的是根地址还是误填了 `/chat/completions`，
   * 后续 `chat/completions`、`models`、`embeddings` 都能被正确拼接，不会重复叠加路径。
   */
  private static normalizeBaseUrl(input: string): string {
    let url = (input ?? '').trim().replace(/\/+$/, '');
    if (!url) return url;

    // 已知的 OpenAI 协议叶子接口后缀（仅剥离到最后一级接口，保留 /v1、/v4 等版本段）
    const knownSuffixes = ['/chat/completions', '/embeddings', '/models'];
    const lower = url.toLowerCase();
    for (const suffix of knownSuffixes) {
      if (lower.endsWith(suffix)) {
        url = url.slice(0, url.length - suffix.length).replace(/\/+$/, '');
        break;
      }
    }
    return url;
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  private toOpenAIMessages(messages: ChatMessage[]): unknown[] {
    return messages.map((m) => {
      const base: Record<string, unknown> = {
        role: m.role,
        content: m.content,
      };
      // 视觉输入：user 消息带 images 时，把 content 转成多模态 content parts
      if (m.role === 'user' && m.images && m.images.length > 0) {
        const parts: unknown[] = [];
        if (m.content && m.content.trim()) {
          parts.push({ type: 'text', text: m.content });
        }
        for (const img of m.images) {
          parts.push({
            type: 'image_url',
            image_url: {
              url: `data:${img.mimeType};base64,${img.base64}`,
            },
          });
        }
        base.content = parts;
      }
      if (m.tool_calls && m.tool_calls.length > 0) {
        base.tool_calls = m.tool_calls.map((tc) => ({
          id: tc.id,
          type: tc.type,
          function: tc.function,
        }));
      }
      if (m.tool_call_id) base.tool_call_id = m.tool_call_id;
      return base;
    });
  }

  async chat(
    messages: ChatMessage[],
    options: ChatOptions,
  ): Promise<ChatResult> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        model: options.model,
        messages: this.toOpenAIMessages(messages),
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(await this.buildError(response));
    }

    const data = (await response.json()) as {
      // content 可能是字符串，也可能是多模态内容块数组（图像生成 / 多模态模型）
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };

    const content = normalizeContentToString(data.choices?.[0]?.message?.content);
    const usage = data.usage;
    return {
      content,
      model: options.model,
      usage:
        usage && usage.total_tokens !== undefined
          ? {
              promptTokens: usage.prompt_tokens ?? 0,
              completionTokens: usage.completion_tokens ?? 0,
              totalTokens: usage.total_tokens,
            }
          : undefined,
    };
  }

  async complete(prompt: string, options: ChatOptions): Promise<ChatResult> {
    return this.chat([{ role: 'user', content: prompt }], options);
  }

  async *streamChat(
    messages: ChatMessage[],
    options: ChatOptions,
  ): AsyncGenerator<string> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        model: options.model,
        messages: this.toOpenAIMessages(messages),
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        stream: true,
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
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') return;

          try {
            const json = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: unknown } }>;
            };
            const delta = json.choices?.[0]?.delta?.content;
            // delta.content 可能是内容块数组（多模态 / 图像生成），统一转成文本
            if (delta != null) {
              const text = normalizeContentToString(delta);
              if (text) yield text;
            }
          } catch {
            // 忽略不完整/心跳行
          }
        }

        if (done) break;
      }
    } finally {
      reader.releaseLock();
    }
  }

  async embedding(
    texts: string[],
    options: EmbeddingOptions,
  ): Promise<EmbeddingResult> {
    const embeddings: number[][] = [];

    for (const text of texts) {
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ model: options.model, input: text }),
      });

      if (!response.ok) {
        throw new Error(await this.buildError(response));
      }

      const data = (await response.json()) as {
        data?: Array<{ embedding?: number[] }>;
      };
      const embedding = data.data?.[0]?.embedding;
      if (!embedding) throw new Error('Embedding 响应缺少 data[0].embedding');
      embeddings.push(embedding);
    }

    return { embeddings, model: options.model };
  }

  async chatWithTools(
    messages: ChatMessage[],
    options: ChatOptions,
    tools: ToolDefinition[],
  ): Promise<ToolChatResult> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        model: options.model,
        messages: this.toOpenAIMessages(messages),
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        tools,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(await this.buildError(response));
    }

    const data = (await response.json()) as {
      choices?: Array<{
        message?: {
          // 同 chat：可能是字符串或内容块数组
          content?: unknown;
          tool_calls?: Array<{
            id?: string;
            type: 'function';
            // 注意：部分 OpenAI 兼容服务会把 arguments 返回成对象而非 JSON 字符串
            function: { name: string; arguments: unknown };
          }>;
        };
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };

    const msg = data.choices?.[0]?.message;
    const rawCalls = msg?.tool_calls ?? [];
    const toolCalls: ToolCall[] = rawCalls.map((c, i) => ({
      id: c.id ?? `call_${i}_${Date.now()}`,
      type: 'function',
      function: {
        name: c.function.name,
        // 归一化为 JSON 字符串（兼容对象形态的 arguments）
        arguments: stringifyToolArguments(c.function.arguments),
      },
    }));

    const usage = data.usage;
    return {
      content: normalizeContentToString(msg?.content),
      toolCalls,
      model: options.model,
      usage:
        usage && usage.total_tokens !== undefined
          ? {
              promptTokens: usage.prompt_tokens ?? 0,
              completionTokens: usage.completion_tokens ?? 0,
              totalTokens: usage.total_tokens,
            }
          : undefined,
    };
  }

  /** 列出该端点支持的模型 ID（连接测试/模型发现用） */
  async listModels(): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/models`, {
      method: 'GET',
      headers: this.headers,
    });

    if (!response.ok) {
      throw new Error(await this.buildError(response));
    }

    const data = (await response.json()) as {
      data?: Array<{ id?: string }>;
    };
    return (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string');
  }

  private async buildError(response: Response): Promise<string> {
    const body = await response.text();
    return `Provider 请求失败: ${response.status}${
      body ? ` - ${body.slice(0, 500)}` : ''
    }`;
  }
}
