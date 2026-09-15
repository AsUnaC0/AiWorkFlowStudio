import { Injectable } from '@nestjs/common';
import { OllamaProvider } from './providers/ollama.provider';

@Injectable()
export class AIService {
  constructor(private readonly ollamaProvider: OllamaProvider) {}

  async chat(params: {
    model: string;
    messages: {
      role: 'system' | 'user' | 'assistant';
      content: string;
    }[];
  }) {
    return this.ollamaProvider.chat(params);
  }

  chatStream(params: {
    model: string;
    messages: {
      role: 'system' | 'user' | 'assistant';
      content: string;
    }[];
  }) {
    return this.ollamaProvider.chatStream(params);
  }
}
