import { Injectable } from '@nestjs/common';

@Injectable()
export class OllamaProvider {
  async *chatStream(params: {
    model: string;
    messages: {
      role: 'system' | 'user' | 'assistant';
      content: string;
    }[];
  }): AsyncGenerator<string> {
    const response = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: params.model,
        messages: params.messages,
        stream: true,
      }),
    });

    if (!response.ok || !response.body) {
      const errorBody = await response.text();
      throw new Error(
        `Ollama 请求失败: ${response.status}${errorBody ? ` - ${errorBody}` : ''}`,
      );
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

  async chat(params: {
    model: string;
    messages: {
      role: 'system' | 'user' | 'assistant';
      content: string;
    }[];
  }): Promise<string> {
    const response = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: params.model,
        messages: params.messages,
        stream: false,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Ollama 请求失败: ${response.status}${errorBody ? ` - ${errorBody}` : ''}`,
      );
    }

    const data = await response.json();

    return data.message.content;
  }
}
