import { Injectable } from '@nestjs/common';
import { AIService } from '../../../ai/ai.service';
import type { ChatMessage, ChatOptions } from '../../../ai/ai-provider.interface';

@Injectable()
export class LLMNodeExecutor {
  constructor(private readonly aiService: AIService) {}

  async execute(context: any, node: any) {
    const { messages, options } = this.createParams(context, node);
    const result = await this.aiService.chat(messages, options);

    return {
      output: result.content,
    };
  }

  async *executeStream(context: any, node: any): AsyncGenerator<string> {
    const { messages, options } = this.createParams(context, node);
    for await (const chunk of this.aiService.streamChat(messages, options)) {
      yield chunk;
    }
  }

  private createParams(
    context: any,
    node: any,
  ): { messages: ChatMessage[]; options: ChatOptions } {
    const systemPrompt = node.config?.prompt ?? '';
    const userInput = String(context.previousOutput ?? context.input ?? '');

    const messages: ChatMessage[] = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: userInput });

    return {
      messages,
      options: {
        model: node.config?.model ?? 'qwen2.5:7b',
        temperature: node.config?.temperature,
        maxTokens: node.config?.maxTokens,
      },
    };
  }
}
