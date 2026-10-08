import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { JwtUser } from '../auth/strategies/jwt.strategy';
import { AgentService } from './agent.service';

/**
 * 无状态 Agent 端点：工具（Workflow / KnowledgeBase）由请求体动态传入。
 * 不再依赖持久化 Agent 记录 —— 用户在聊天页选好工作流 + 知识库，直接发送。
 */
@Controller('agent')
@UseGuards(JwtAuthGuard)
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

  /**
   * 获取当前用户可见的已发布工作流 + 知识库。
   * 前端聊天页的 Workflow / KnowledgeBase 下拉用。
   */
  @Get('resources')
  async getResources(@CurrentUser() user: JwtUser) {
    return this.agentService.getAvailableResources(user.id);
  }

  /**
   * 非流式运行 —— 返回最终 answer。
   * 适合测试或程序化调用。
   */
  @Post('chat')
  async run(
    @CurrentUser() user: JwtUser,
    @Body()
    body: {
      input: string;
      history?: any[];
      model?: string;
      workflowIds?: string[];
      knowledgeBaseIds?: string[];
      systemPrompt?: string;
      temperature?: number;
      maxToolIterations?: number;
    },
  ) {
    if (!body.input?.trim()) {
      throw new HttpException('input 不能为空', HttpStatus.BAD_REQUEST);
    }

    return this.agentService.run(
      user.id,
      {
        model: body.model ?? 'qwen2.5:7b',
        workflowIds: body.workflowIds ?? [],
        knowledgeBaseIds: body.knowledgeBaseIds ?? [],
        systemPrompt: body.systemPrompt,
        temperature: body.temperature,
        maxToolIterations: body.maxToolIterations,
      },
      {
        input: body.input,
        history: body.history,
      },
    );
  }

  /**
   * SSE 流式运行 —— 推事件给前端聊天页。
   *
   * 请求体：
   *   input               用户输入（必填）
   *   history             多轮对话历史（可选）
   *   model               LLM 模型名（默认 qwen2.5:7b）
   *   workflowIds         绑定的已发布工作流 ID 列表（可选）
   *   knowledgeBaseIds    绑定的知识库 ID 列表（可选）
   *   systemPrompt        System Prompt（可选）
   *   temperature         温度（默认 0.7）
   *   maxToolIterations   ReAct 循环上限（默认 10）
   *
   * SSE 事件类型：
   *   thinking       → LLM 思考中
   *   tool_call      → LLM 决定调用哪个工具 + 参数
   *   tool_result    → 工具返回结果 + 耗时
   *   message        → 最终回答
   *   error          → 错误
   */
  @Post('chat/stream')
  async runStream(
    @CurrentUser() user: JwtUser,
    @Body()
    body: {
      input: string;
      history?: any[];
      model?: string;
      workflowIds?: string[];
      knowledgeBaseIds?: string[];
      systemPrompt?: string;
      temperature?: number;
      maxToolIterations?: number;
    },
    @Res() response: Response,
  ) {
    if (!body.input?.trim()) {
      throw new HttpException('input 不能为空', HttpStatus.BAD_REQUEST);
    }

    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders();

    const send = (event: unknown) => {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      for await (const event of this.agentService.runStream(
        user.id,
        {
          model: body.model ?? 'qwen2.5:7b',
          workflowIds: body.workflowIds ?? [],
          knowledgeBaseIds: body.knowledgeBaseIds ?? [],
          systemPrompt: body.systemPrompt,
          temperature: body.temperature,
          maxToolIterations: body.maxToolIterations,
        },
        {
          input: body.input,
          history: body.history,
        },
      )) {
        send(event);
      }
    } catch (error) {
      send({
        type: 'error',
        message: error instanceof Error ? error.message : 'Agent 运行失败',
      });
    } finally {
      response.end();
    }
  }
}
