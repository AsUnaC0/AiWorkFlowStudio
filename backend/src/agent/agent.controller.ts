import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { JwtUser } from '../auth/strategies/jwt.strategy';
import { AgentService } from './agent.service';
import { ChatSessionService } from './chat-session.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { CreateSessionDto, UpdateSessionDto } from './dto/chat-session.dto';

/**
 * Agent + ChatSession 统一端点。
 *
 * Agent CRUD:
 *   GET    /agents            — 列出当前用户可见的所有 Agent
 *   POST   /agents            — 创建新 Agent
 *   GET    /agents/:id        — Agent 详情
 *   PATCH  /agents/:id        — 更新 Agent
 *   DELETE /agents/:id        — 删除 Agent
 *
 * ChatSession CRUD:
 *   GET    /agents/:agentId/sessions            — 列出某 Agent 的会话
 *   POST   /agents/:agentId/sessions            — 创建新会话
 *   GET    /sessions/:sessionId                 — 会话详情 + 消息
 *   PATCH  /sessions/:sessionId                 — 更新会话（标题）
 *   DELETE /sessions/:sessionId                 — 删除会话
 *
 * Chat:
 *   POST   /agents/:agentId/chat                — 非流式
 *   POST   /agents/:agentId/chat/stream         — SSE 流式
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class AgentController {
  constructor(
    private readonly agentService: AgentService,
    private readonly sessionService: ChatSessionService,
  ) {}

  // ===========================================================================
  // Agent CRUD
  // ===========================================================================

  @Get('agents')
  async listAgents(@CurrentUser() user: JwtUser) {
    return this.agentService.list(user.id);
  }

  @Post('agents')
  async createAgent(
    @CurrentUser() user: JwtUser,
    @Body() dto: CreateAgentDto,
  ) {
    return this.agentService.create(user.id, dto);
  }

  @Get('agents/:id')
  async getAgent(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
  ) {
    return this.agentService.findOne(user.id, id);
  }

  @Patch('agents/:id')
  async updateAgent(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: UpdateAgentDto,
  ) {
    return this.agentService.update(user.id, id, dto);
  }

  @Delete('agents/:id')
  async deleteAgent(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
  ) {
    return this.agentService.remove(user.id, id);
  }

  // ===========================================================================
  // 资源查询（前端下拉用）
  // ===========================================================================

  @Get('agent/resources')
  async getResources(@CurrentUser() user: JwtUser) {
    return this.agentService.getAvailableResources(user.id);
  }

  // ===========================================================================
  // ChatSession CRUD
  // ===========================================================================

  @Get('agents/:agentId/sessions')
  async listSessions(
    @CurrentUser() user: JwtUser,
    @Param('agentId') agentId: string,
  ) {
    return this.sessionService.listByAgent(user.id, agentId);
  }

  @Post('agents/:agentId/sessions')
  async createSession(
    @CurrentUser() user: JwtUser,
    @Param('agentId') agentId: string,
    @Body() dto: CreateSessionDto,
  ) {
    return this.sessionService.create(user.id, agentId, dto.title);
  }

  @Get('sessions/:sessionId')
  async getSession(
    @CurrentUser() user: JwtUser,
    @Param('sessionId') sessionId: string,
  ) {
    return this.sessionService.getWithMessages(user.id, sessionId);
  }

  @Patch('sessions/:sessionId')
  async updateSession(
    @CurrentUser() user: JwtUser,
    @Param('sessionId') sessionId: string,
    @Body() dto: UpdateSessionDto,
  ) {
    return this.sessionService.update(user.id, sessionId, dto);
  }

  @Delete('sessions/:sessionId')
  async deleteSession(
    @CurrentUser() user: JwtUser,
    @Param('sessionId') sessionId: string,
  ) {
    return this.sessionService.remove(user.id, sessionId);
  }

  // ===========================================================================
  // Chat（基于 Agent 配置执行）
  // ===========================================================================

  /**
   * 非流式 —— 返回最终 answer（简化版，不持久化消息）。
   */
  @Post('agents/:agentId/chat')
  async run(
    @CurrentUser() user: JwtUser,
    @Param('agentId') agentId: string,
    @Body() body: { input: string; sessionId?: string },
  ) {
    if (!body.input?.trim()) {
      throw new HttpException('input 不能为空', HttpStatus.BAD_REQUEST);
    }

    // 历史消息（如果有 sessionId）
    let history: Awaited<ReturnType<ChatSessionService['getHistoryForLLM']>> | undefined;
    if (body.sessionId) {
      history = await this.sessionService.getHistoryForLLM(body.sessionId);
      // 排除最后一条（用户刚发的）
      history = history.slice(0, -1);
    }

    let lastEvent: { answer?: string; error?: string } = {};
    for await (const event of this.agentService.runStream(
      user.id,
      { agentId, input: body.input, sessionId: body.sessionId },
      history as any,
    )) {
      if (event.type === 'message') lastEvent.answer = event.content;
      if (event.type === 'error') lastEvent.error = event.message;
    }

    if (lastEvent.error) {
      throw new HttpException(lastEvent.error, HttpStatus.INTERNAL_SERVER_ERROR);
    }
    return { answer: lastEvent.answer };
  }

  /**
   * SSE 流式 —— 推事件给前端聊天页。
   *
   * 请求体：
   *   input       用户输入（必填）
   *   sessionId   会话 ID（可选，传入则持久化 + 加载历史）
   *
   * SSE 事件类型：
   *   thinking / tool_call / tool_result / message / error
   */
  @Post('agents/:agentId/chat/stream')
  async runStream(
    @CurrentUser() user: JwtUser,
    @Param('agentId') agentId: string,
    @Body() body: { input: string; sessionId?: string },
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
      // 历史消息
      let history: Awaited<ReturnType<ChatSessionService['getHistoryForLLM']>> | undefined;
      if (body.sessionId) {
        history = await this.sessionService.getHistoryForLLM(body.sessionId);
      }

      for await (const event of this.agentService.runStream(
        user.id,
        { agentId, input: body.input, sessionId: body.sessionId },
        history as any,
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
