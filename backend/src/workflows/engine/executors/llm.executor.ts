import { Injectable } from '@nestjs/common';
import { AIService } from '../../../ai/ai.service';

@Injectable()
export class LLMNodeExecutor {
  constructor(private readonly aiService: AIService) {}

  async execute(context: any, node: any) {
    const result = await this.aiService.chat(
      this.createChatParams(context, node),
    );

    return {
      output: result,
    };
  }

  async *executeStream(context: any, node: any): AsyncGenerator<string> {
    for await (const chunk of this.aiService.chatStream(
      this.createChatParams(context, node),
    )) {
      yield chunk;
    }
  }

  private createChatParams(context: any, node: any) {
    const prompt = node.config?.prompt ?? '';
    const input = String(context.previousOutput ?? context.input ?? '');

    return {
      model: node.config?.model ?? 'qwen2.5:7b',
      messages: [
        { role: 'system' as const, content: prompt },
        { role: 'user' as const, content: input },
      ],
    };
  }
}
