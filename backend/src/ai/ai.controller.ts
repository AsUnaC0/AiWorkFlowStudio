import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AI_PROVIDER } from './ai-provider.interface';
import { AIService } from './ai.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { ChatMessage } from './ai-provider.interface';

const OLLAMA_BASE_URL = 'http://localhost:11434';

@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(
    private readonly aiService: AIService,
    @Inject(AI_PROVIDER) private readonly provider: { readonly name: string },
  ) {}

  /** 获取可用的模型列表 */
  @Get('models')
  async listModels() {
    try {
      const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
      if (!response.ok) {
        throw new HttpException('无法连接到 Ollama 服务', HttpStatus.BAD_GATEWAY);
      }
      const data = (await response.json()) as {
        models: { name: string; size?: number; modified_at?: string }[];
      };
      return {
        provider: this.provider.name,
        models: data.models.map((m) => ({
          name: m.name,
          size: m.size,
          modifiedAt: m.modified_at,
        })),
      };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      // Ollama 没启动时返回兜底默认值
      return {
        provider: this.provider.name,
        models: [
          { name: 'qwen2.5:7b', size: 0, modifiedAt: null },
          { name: 'qwen2.5:3b', size: 0, modifiedAt: null },
          { name: 'deepseek-r1:7b', size: 0, modifiedAt: null },
          { name: 'nomic-embed-text', size: 0, modifiedAt: null },
        ],
        note: 'Ollama 未连接，返回默认模型列表',
      };
    }
  }

  /**
   * 简单聊天接口
   * 请求体：{ model, messages: [{ role, content }], temperature?, maxTokens? }
   * 后续扩展：knowledgeBaseIds（RAG）、workflowId（Agent 调用）
   */
  @Post('chat')
  async chat(
    @Body() body: {
      model: string;
      messages: ChatMessage[];
      temperature?: number;
      maxTokens?: number;
      knowledgeBaseIds?: string[];
    },
  ) {
    if (!body.model) {
      throw new HttpException('model 不能为空', HttpStatus.BAD_REQUEST);
    }
    if (!body.messages?.length) {
      throw new HttpException('messages 不能为空', HttpStatus.BAD_REQUEST);
    }

    // TODO: 如果传了 knowledgeBaseIds，先调 KnowledgeRetrievalService 检索
    // 然后把检索结果注入 System Prompt 再调用 chat

    return this.aiService.chat(body.messages, {
      model: body.model,
      temperature: body.temperature ?? 0.7,
      maxTokens: body.maxTokens,
    });
  }
}
