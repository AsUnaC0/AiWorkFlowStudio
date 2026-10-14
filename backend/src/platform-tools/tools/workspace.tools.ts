import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  PlatformTool,
  PlatformToolContext,
  PlatformToolOutcome,
} from '../platform-tool.interface';

/**
 * 工作空间相关工具。
 *
 * 权限：只返回「当前用户是 owner 或 member」的空间，
 * 并且标记出每个空间里用户的角色 —— 后续写操作工具据此判断能不能动。
 */
@Injectable()
export class WorkspaceTools {
  constructor(private readonly prisma: PrismaService) {}

  readonly tools: PlatformTool[] = [
    {
      name: 'list_workspaces',
      meta: {
        label: '查询工作空间',
        action: 'QUERY',
        riskLevel: 'LOW',
        targetType: 'workspace',
      },
      definition: {
        type: 'function',
        function: {
          name: 'list_workspaces',
          description:
            '查询当前用户可访问的工作空间（含角色 OWNER/MEMBER、工作流数量）。' +
            '当用户说「当前工作空间」「我的空间」但没指明具体是哪个时，先调用本工具确认。',
          parameters: {
            type: 'object',
            properties: {
              keyword: {
                type: 'string',
                description: '可选：按名称模糊筛选',
              },
            },
          },
        },
      },
      execute: (args, ctx) => this.listWorkspaces(args, ctx),
    },
  ];

  private async listWorkspaces(
    args: Record<string, unknown>,
    ctx: PlatformToolContext,
  ): Promise<PlatformToolOutcome> {
    const keyword =
      typeof args.keyword === 'string' ? args.keyword.trim() : undefined;

    const workspaces = await this.prisma.workspace.findMany({
      where: {
        OR: [
          { ownerId: ctx.userId },
          { members: { some: { userId: ctx.userId } } },
        ],
        ...(keyword
          ? { name: { contains: keyword, mode: 'insensitive' } }
          : {}),
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        ownerId: true,
        createdAt: true,
        _count: { select: { members: true, workflows: true } },
      },
    });

    if (workspaces.length === 0) {
      return {
        text: keyword
          ? `没有找到名称包含「${keyword}」的工作空间。`
          : '当前用户还没有任何工作空间。创建工作流之前需要先有一个工作空间。',
        targetType: 'workspace',
        summary: '查询工作空间（0 个）',
      };
    }

    const lines = workspaces.map((ws) => {
      const role = ws.ownerId === ctx.userId ? 'OWNER' : 'MEMBER';
      const current = ws.id === ctx.workspaceId ? ' ← 当前工作空间' : '';
      return `- ${ws.name}｜id=${ws.id}｜角色=${role}｜成员=${ws._count.members}｜工作流=${ws._count.workflows}${current}`;
    });

    return {
      text: [
        `共 ${workspaces.length} 个工作空间：`,
        ...lines,
        '',
        '（后续创建工作流时，把目标工作空间的 id 作为 workspaceId 传入）',
      ].join('\n'),
      targetType: 'workspace',
      summary: `查询工作空间（${workspaces.length} 个）`,
    };
  }
}
