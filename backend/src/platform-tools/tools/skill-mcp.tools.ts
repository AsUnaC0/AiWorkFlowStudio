import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  PlatformTool,
  PlatformToolContext,
  PlatformToolOutcome,
} from '../platform-tool.interface';
import { asOptionalString } from '../platform-tool.interface';

/**
 * Skill / MCP / 平台总览 相关工具。
 *
 * 这一组是「只读能力清单」—— 让平台助理在回答「我有哪些能力」「哪些 MCP 掉线了」
 * 「还有哪些知识库没索引完」这类问题时，能一次拿到全局视图，
 * 而不是让模型逐个工具串行试探。
 */
@Injectable()
export class SkillMcpTools {
  constructor(private readonly prisma: PrismaService) {}

  readonly tools: PlatformTool[] = [
    {
      name: 'list_skills',
      meta: {
        label: '查询 Skill',
        action: 'QUERY',
        riskLevel: 'LOW',
        targetType: 'skill',
      },
      definition: {
        type: 'function',
        function: {
          name: 'list_skills',
          description:
            '查询当前用户的 Skill 列表（PROMPT / WORKFLOW / TOOL 三种类型），含绑定的工作流或 MCP 工具。',
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
      execute: (args, ctx) => this.listSkills(args, ctx),
    },

    {
      name: 'list_mcp_servers',
      meta: {
        label: '查询 MCP Server',
        action: 'QUERY',
        riskLevel: 'LOW',
        targetType: 'mcp_server',
      },
      definition: {
        type: 'function',
        function: {
          name: 'list_mcp_servers',
          description:
            '查询当前用户配置的 MCP Server 列表，含连接状态、最近错误、已发现的工具数量。' +
            '当用户问「哪些 MCP 连不上」时使用。',
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
      execute: (args, ctx) => this.listMcpServers(args, ctx),
    },

    {
      name: 'get_platform_overview',
      meta: {
        label: '查询平台总览',
        action: 'QUERY',
        riskLevel: 'LOW',
        targetType: 'platform',
      },
      definition: {
        type: 'function',
        function: {
          name: 'get_platform_overview',
          description:
            '一次性获取平台资源总览：工作空间 / 工作流（含发布与失败情况）/ 知识库（含索引进度）/ Agent / Skill / MCP 的状态汇总，' +
            '以及当前工作空间信息。适合回答「我的平台现在什么情况」「有哪些需要处理的问题」。',
          parameters: {
            type: 'object',
            properties: {},
          },
        },
      },
      execute: (_args, ctx) => this.overview(ctx),
    },
  ];

  // =========================================================================
  // 实现
  // =========================================================================

  private async listSkills(
    args: Record<string, unknown>,
    ctx: PlatformToolContext,
  ): Promise<PlatformToolOutcome> {
    const keyword = asOptionalString(args.keyword);

    const skills = await this.prisma.skill.findMany({
      where: {
        ownerId: ctx.userId,
        ...(keyword
          ? { name: { contains: keyword, mode: 'insensitive' } }
          : {}),
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        description: true,
        type: true,
        workflowId: true,
        mcpServerId: true,
        mcpToolName: true,
        outputFormat: true,
      },
    });

    if (skills.length === 0) {
      return {
        text: '当前用户还没有创建 Skill。',
        targetType: 'skill',
        summary: '查询 Skill（0 个）',
      };
    }

    const lines = skills.map((s) =>
      [
        `- ${s.name}｜id=${s.id}｜类型=${s.type}｜输出=${s.outputFormat}`,
        s.workflowId ? `  绑定工作流=${s.workflowId}` : '',
        s.mcpServerId
          ? `  绑定 MCP=${s.mcpServerId}${s.mcpToolName ? ` / ${s.mcpToolName}` : ''}`
          : '',
        s.description ? `  说明=${s.description}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );

    return {
      text: `共 ${skills.length} 个 Skill：\n${lines.join('\n')}`,
      targetType: 'skill',
      summary: `查询 Skill（${skills.length} 个）`,
    };
  }

  private async listMcpServers(
    args: Record<string, unknown>,
    ctx: PlatformToolContext,
  ): Promise<PlatformToolOutcome> {
    const keyword = asOptionalString(args.keyword);

    const servers = await this.prisma.mcpServer.findMany({
      where: {
        ownerId: ctx.userId,
        ...(keyword
          ? { name: { contains: keyword, mode: 'insensitive' } }
          : {}),
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        description: true,
        transport: true,
        authType: true,
        status: true,
        lastError: true,
        availableTools: true,
        serverName: true,
        lastConnectedAt: true,
      },
    });

    if (servers.length === 0) {
      return {
        text: '当前用户还没有配置 MCP Server。',
        targetType: 'mcp_server',
        summary: '查询 MCP Server（0 个）',
      };
    }

    const lines = servers.map((s) => {
      const toolCount = Array.isArray(s.availableTools)
        ? s.availableTools.length
        : 0;
      return [
        `- ${s.name}｜id=${s.id}｜状态=${s.status}`,
        `  传输=${s.transport}｜认证=${s.authType}｜可用工具=${toolCount}${
          s.serverName ? `｜服务端=${s.serverName}` : ''
        }`,
        s.lastError ? `  ⚠️ 最近错误：${s.lastError}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    });

    const broken = servers.filter((s) => s.status === 'ERROR').length;

    return {
      text: `共 ${servers.length} 个 MCP Server（异常 ${broken} 个）：\n${lines.join('\n')}`,
      targetType: 'mcp_server',
      summary: `查询 MCP Server（${servers.length} 个，异常 ${broken} 个）`,
    };
  }

  private async overview(
    ctx: PlatformToolContext,
  ): Promise<PlatformToolOutcome> {
    const userId = ctx.userId;

    const [
      workspaces,
      workflowTotal,
      workflowByStatus,
      knowledgeBases,
      documentsByStatus,
      agentCount,
      skillCount,
      mcpServers,
      recentFailedRuns,
      operationStats,
    ] = await Promise.all([
      this.prisma.workspace.findMany({
        where: {
          OR: [{ ownerId: userId }, { members: { some: { userId } } }],
        },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          name: true,
          ownerId: true,
          _count: { select: { workflows: true, members: true } },
        },
      }),
      this.prisma.workflow.count({
        where: {
          workspace: {
            OR: [{ ownerId: userId }, { members: { some: { userId } } }],
          },
        },
      }),
      this.prisma.workflow.groupBy({
        by: ['status'],
        where: {
          workspace: {
            OR: [{ ownerId: userId }, { members: { some: { userId } } }],
          },
        },
        _count: { _all: true },
      }),
      this.prisma.knowledgeBase.findMany({
        where: { ownerId: userId },
        select: {
          id: true,
          name: true,
          documentCount: true,
          chunkCount: true,
          documents: { select: { status: true } },
        },
      }),
      this.prisma.document.groupBy({
        by: ['status'],
        where: { knowledgeBase: { ownerId: userId } },
        _count: { _all: true },
      }),
      this.prisma.agent.count({ where: { createdBy: userId } }),
      this.prisma.skill.count({ where: { ownerId: userId } }),
      this.prisma.mcpServer.findMany({
        where: { ownerId: userId },
        select: { id: true, name: true, status: true },
      }),
      this.prisma.workflowRun.findMany({
        where: {
          status: 'FAILED',
          workflow: {
            workspace: {
              OR: [{ ownerId: userId }, { members: { some: { userId } } }],
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          createdAt: true,
          errorCode: true,
          errorMessage: true,
          workflow: { select: { id: true, name: true } },
        },
      }),
      this.prisma.platformOperationLog.groupBy({
        by: ['status'],
        where: { userId },
        _count: { _all: true },
      }),
    ]);

    const statusCount = (status: string) =>
      workflowByStatus.find((g) => g.status === status)?._count._all ?? 0;
    const docStatus = (status: string) =>
      documentsByStatus.find((g) => g.status === status)?._count._all ?? 0;

    const incompleteKbs = knowledgeBases.filter((kb) =>
      kb.documents.some(
        (d) =>
          d.status === 'UPLOADED' ||
          d.status === 'PROCESSING' ||
          d.status === 'FAILED',
      ),
    );
    const brokenMcp = mcpServers.filter((s) => s.status === 'ERROR');

    const currentWorkspace = workspaces.find((w) => w.id === ctx.workspaceId);

    const lines: string[] = [
      '【平台资源总览】',
      `工作空间：${workspaces.length} 个${
        currentWorkspace
          ? `（当前：${currentWorkspace.name}）`
          : '（未指定当前工作空间）'
      }`,
      `工作流：${workflowTotal} 个（草稿 ${statusCount('DRAFT')}｜已发布 ${statusCount('PUBLISHED')}｜已归档 ${statusCount('ARCHIVED')}）`,
      `知识库：${knowledgeBases.length} 个｜文档总数 ${documentsByStatus.reduce(
        (sum, g) => sum + g._count._all,
        0,
      )}（已完成 ${docStatus('COMPLETED')}｜处理中 ${
        docStatus('UPLOADED') + docStatus('PROCESSING')
      }｜失败 ${docStatus('FAILED')}）`,
      `Agent：${agentCount} 个（不含系统内置）`,
      `Skill：${skillCount} 个`,
      `MCP Server：${mcpServers.length} 个（异常 ${brokenMcp.length} 个）`,
    ];

    if (workspaces.length > 0) {
      lines.push('', '工作空间明细：');
      for (const ws of workspaces) {
        lines.push(
          `- ${ws.name}（id=${ws.id}）｜角色=${
            ws.ownerId === userId ? 'OWNER' : 'MEMBER'
          }｜工作流 ${ws._count.workflows}｜成员 ${ws._count.members}`,
        );
      }
    }

    if (incompleteKbs.length > 0) {
      lines.push('', '⚠️ 索引未完成的知识库：');
      for (const kb of incompleteKbs) {
        const pending = kb.documents.filter(
          (d) => d.status === 'UPLOADED' || d.status === 'PROCESSING',
        ).length;
        const failed = kb.documents.filter((d) => d.status === 'FAILED').length;
        lines.push(
          `- ${kb.name}（id=${kb.id}）｜处理中 ${pending}｜失败 ${failed}`,
        );
      }
    }

    if (recentFailedRuns.length > 0) {
      lines.push('', '⚠️ 最近失败的工作流运行：');
      for (const run of recentFailedRuns) {
        lines.push(
          `- ${run.workflow.name}｜${run.createdAt.toISOString()}｜${
            run.errorCode ? `[${run.errorCode}] ` : ''
          }${(run.errorMessage ?? '').slice(0, 120)}`,
        );
      }
    }

    if (brokenMcp.length > 0) {
      lines.push(
        '',
        `⚠️ 连接异常的 MCP Server：${brokenMcp.map((s) => s.name).join('、')}`,
      );
    }

    if (operationStats.length > 0) {
      lines.push(
        '',
        `平台操作记录：${operationStats
          .map((s) => `${s.status} ${s._count._all}`)
          .join('｜')}`,
      );
    }

    return {
      text: lines.join('\n'),
      targetType: 'platform',
      summary: `平台总览（工作空间 ${workspaces.length}｜工作流 ${workflowTotal}｜知识库 ${knowledgeBases.length}｜Agent ${agentCount}）`,
    };
  }
}
