import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { ChatMessage as LlmChatMessage } from '../ai/ai-provider.interface';

/**
 * ChatSession 服务 —— 会话隔离。
 *
 * 权限模型：
 *   - 系统 Agent（isSystem=true）：所有人可创建/查看会话
 *   - 用户 Agent（isSystem=false）：只有创建者（createdBy）可操作
 */
@Injectable()
export class ChatSessionService {
  constructor(private readonly prisma: PrismaService) {}

  /** 校验用户对 Agent 有访问权限 */
  private async assertAgentAccessible(agentId: string, userId: string) {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
    });
    if (!agent) throw new NotFoundException('Agent 不存在');
    if (!agent.isSystem && agent.createdBy !== userId) {
      throw new ForbiddenException('无权访问此 Agent');
    }
    return agent;
  }

  async listByAgent(userId: string, agentId: string) {
    await this.assertAgentAccessible(agentId, userId);

    return this.prisma.chatSession.findMany({
      where: { agentId, userId },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { messages: true } },
      },
    });
  }

  async getWithMessages(userId: string, sessionId: string) {
    const session = await this.prisma.chatSession.findFirst({
      where: { id: sessionId, userId },
      include: {
        agent: { select: { id: true, name: true, type: true } },
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!session) throw new NotFoundException('会话不存在');
    return session;
  }

  async create(userId: string, agentId: string, title?: string) {
    await this.assertAgentAccessible(agentId, userId);

    return this.prisma.chatSession.create({
      data: {
        userId,
        agentId,
        title: title ?? '新对话',
      },
    });
  }

  async update(userId: string, sessionId: string, data: { title?: string }) {
    const session = await this.prisma.chatSession.findFirst({
      where: { id: sessionId, userId },
      select: { id: true },
    });
    if (!session) throw new NotFoundException('会话不存在');

    return this.prisma.chatSession.update({
      where: { id: sessionId },
      data,
    });
  }

  async remove(userId: string, sessionId: string) {
    const session = await this.prisma.chatSession.findFirst({
      where: { id: sessionId, userId },
      select: { id: true },
    });
    if (!session) throw new NotFoundException('会话不存在');

    return this.prisma.chatSession.delete({ where: { id: sessionId } });
  }

  async getHistoryForLLM(sessionId: string): Promise<LlmChatMessage[]> {
    const dbMessages = await this.prisma.chatMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
    });

    return dbMessages.map((m) => {
      const base: LlmChatMessage = {
        role: m.role as LlmChatMessage['role'],
        content: m.content,
      };

      if (m.role === 'assistant' && m.toolCalls) {
        try {
          base.tool_calls = m.toolCalls as any;
        } catch {
          // ignore
        }
      }

      if (m.role === 'tool' && m.toolCallId) {
        base.tool_call_id = m.toolCallId;
      }

      return base;
    });
  }
}
