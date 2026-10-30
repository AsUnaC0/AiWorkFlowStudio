import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  PlatformTool,
  PlatformToolContext,
  PlatformToolOutcome,
} from '../platform-tool.interface';

/**
 * 用户与身份相关工具。
 *
 * 注意：这里的「当前用户」永远来自 `ctx.userId`（后端已验证的 JWT 上下文），
 * 工具入参里没有任何 userId 字段 —— 模型无法声明自己是谁。
 */
@Injectable()
export class UserTools {
  constructor(private readonly prisma: PrismaService) {}

  readonly tools: PlatformTool[] = [
    {
      name: 'get_current_user',
      meta: {
        label: '获取当前用户信息',
        action: 'QUERY',
        riskLevel: 'LOW',
        targetType: 'user',
      },
      definition: {
        type: 'function',
        function: {
          name: 'get_current_user',
          description:
            '获取当前登录用户的基本信息与资源总量（工作空间 / 工作流 / 知识库 / Agent / Skill / MCP 数量）。' +
            '当用户问「我有多少…」「我是谁」「我有哪些资源」时使用。',
          parameters: {
            type: 'object',
            properties: {},
          },
        },
      },
      execute: (_args, ctx) => this.getCurrentUser(ctx),
    },
  ];

  private async getCurrentUser(
    ctx: PlatformToolContext,
  ): Promise<PlatformToolOutcome> {
    const user = await this.prisma.user.findUnique({
      where: { id: ctx.userId },
      select: {
        id: true,
        username: true,
        email: true,
        status: true,
        createdAt: true,
      },
    });

    if (!user) {
      return {
        text: '错误：当前用户不存在（账号可能已被删除）。',
        status: 'FAILED',
        summary: '用户不存在',
      };
    }

    const [
      workspaceCount,
      workflowCount,
      knowledgeBaseCount,
      agentCount,
      skillCount,
      mcpServerCount,
    ] = await Promise.all([
      this.prisma.workspace.count({
        where: {
          OR: [
            { ownerId: ctx.userId },
            { members: { some: { userId: ctx.userId } } },
          ],
        },
      }),
      this.prisma.workflow.count({
        where: {
          workspace: {
            OR: [
              { ownerId: ctx.userId },
              { members: { some: { userId: ctx.userId } } },
            ],
          },
        },
      }),
      this.prisma.knowledgeBase.count({ where: { ownerId: ctx.userId } }),
      // 系统默认 Agent 每用户一条，但那是平台内置能力，不计入「我的 Agent」
      this.prisma.agent.count({
        where: { createdBy: ctx.userId, isSystem: false },
      }),
      this.prisma.skill.count({ where: { ownerId: ctx.userId } }),
      this.prisma.mcpServer.count({ where: { ownerId: ctx.userId } }),
    ]);

    const text = [
      `当前用户：${user.username}（${user.email}）`,
      `账号状态：${user.status}`,
      `注册时间：${user.createdAt.toISOString().slice(0, 10)}`,
      '',
      '资源总量：',
      `- 工作空间：${workspaceCount}`,
      `- 工作流：${workflowCount}`,
      `- 知识库：${knowledgeBaseCount}`,
      `- Agent（自建）：${agentCount}`,
      `- Skill：${skillCount}`,
      `- MCP Server：${mcpServerCount}`,
    ].join('\n');

    return {
      text,
      targetType: 'user',
      targetId: user.id,
      targetName: user.username,
      summary: `读取用户信息（工作空间 ${workspaceCount} / 工作流 ${workflowCount} / 知识库 ${knowledgeBaseCount}）`,
    };
  }
}
