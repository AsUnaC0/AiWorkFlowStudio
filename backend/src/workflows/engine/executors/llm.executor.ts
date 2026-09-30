import { Injectable } from '@nestjs/common';
import { AIService } from '../../../ai/ai.service';
import type {
  ChatMessage,
  ChatOptions,
} from '../../../ai/ai-provider.interface';
import { NodeExecutionContext } from '../node-executor.interface';
import { VariableService } from '../variable.service';

@Injectable()
export class LLMNodeExecutor {
  constructor(
    private readonly aiService: AIService,
    private readonly variableService: VariableService,
  ) {}

  async execute(context: NodeExecutionContext, node: any) {
    const { messages, options } = this.createParams(context, node);
    const result = await this.aiService.chat(messages, options);

    return {
      output: result.content,
    };
  }

  async *executeStream(
    context: NodeExecutionContext,
    node: any,
  ): AsyncGenerator<string> {
    const { messages, options } = this.createParams(context, node);
    for await (const chunk of this.aiService.streamChat(messages, options)) {
      yield chunk;
    }
  }

  private createParams(
    context: NodeExecutionContext,
    node: any,
  ): { messages: ChatMessage[]; options: ChatOptions } {
    // system prompt 支持 {{变量}} 引用
    const rawSystemPrompt = String(node.config?.prompt ?? '');
    const systemPrompt = String(
      this.variableService.resolve(rawSystemPrompt, context) ?? '',
    );

    // user input：优先用 previousOutput，也支持 {{变量}} 模板
    const rawUserInput = String(
      node.config?.userPrompt ?? context.previousOutput ?? context.input ?? '',
    );
    const userInput = String(
      this.variableService.resolve(rawUserInput, context) ?? '',
    );

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
