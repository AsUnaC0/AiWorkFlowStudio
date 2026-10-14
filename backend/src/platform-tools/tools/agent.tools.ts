import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmConfigService } from '../../llm-config/llm-config.service';
import type {
  PlatformTool,
  PlatformToolContext,
  PlatformToolOutcome,
} from '../platform-tool.interface';
import {
  asOptionalString,
  asString,
  asStringArray,
} from '../platform-tool.interface';

const AGENT_TYPE_LABELS: Record<string, string> = {
  GENERAL: '通用助手',
  KNOWLEDGE: '知识库问答',
  WORKFLOW: '工作流助手',
  TOOL: '工具型助手',
  CUSTOM: '自定义',
};

/**
 * Agent 相关平台工具。
 *
 * 权限模型（与 AgentService 保持一致）：
 *   - 系统 Agent（isSystem=true）：所有人可见；不可改身份 / 绑定资源，仅模型配置可改；不可删
 *   - 用户 Agent：只有 createdBy 本人可见、可改
 *
 * 这里刻意**不注入 AgentService**，直接走 Prisma —— 避免
 * AgentModule → AssistantModule → PlatformToolsModule → AgentModule 的循环依赖。
 * 因此创建逻辑需要与 AgentService.create 的默认值保持同步（type / status / 运行参数）。
 */
@Injectable()
export class AgentTools {
  private readonly logger = new Logger(AgentTools.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llmConfigService: LlmConfigService,
  ) {}

  readonly tools: PlatformTool[] = [
    {
      name: 'list_agents',
      meta: {
        label: '查询 Agent',
        action: 'QUERY',
        riskLevel: 'LOW',
        targetType: 'agent',
      },
      definition: {
        type: 'function',
        function: {
          name: 'list_agents',
          description:
            '查询当前用户可见的 Agent（含系统内置的平台助理与用户自建 Agent），' +
            '以及每个 Agent 绑定的工作流 / 知识库 / Skill / MCP 数量。',
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
      execute: (args, ctx) => this.listAgents(args, ctx),
    },

    {
      name: 'create_agent',
      meta: {
        label: '创建 Agent',
        action: 'CREATE',
        riskLevel: 'MEDIUM',
        targetType: 'agent',
      },
      definition: {
        type: 'function',
        function: {
          name: 'create_agent',
          description: [
            '为当前用户创建一个新的 Agent，可绑定已有的工作流、知识库、Skill、MCP Server。',
            '绑定的资源 id 必须来自当前用户可访问的资源，否则会创建失败。',
            '创建后返回 Agent id 与配置页链接。',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Agent 名称',
              },
              description: {
                type: 'string',
                description: '可选：用途说明',
              },
              type: {
                type: 'string',
                enum: ['GENERAL', 'KNOWLEDGE', 'WORKFLOW', 'TOOL', 'CUSTOM'],
                description: 'Agent 类型，默认 CUSTOM',
              },
              systemPrompt: {
                type: 'string',
                description: '可选：System Prompt（角色与行为规则）',
              },
              llmModelId: {
                type: 'string',
                description:
                  '可选：绑定用户在「模型管理」中添加的对话模型 id；不传则用本地默认模型',
              },
              workflowIds: {
                type: 'array',
                items: { type: 'string' },
                description: '可选：绑定的已发布工作流 id 列表',
              },
              knowledgeBaseIds: {
                type: 'array',
                items: { type: 'string' },
                description: '可选：绑定的知识库 id 列表',
              },
              skillIds: {
                type: 'array',
                items: { type: 'string' },
                description: '可选：绑定的 Skill id 列表',
              },
              mcpServerIds: {
                type: 'array',
                items: { type: 'string' },
                description: '可选：绑定的 MCP Server id 列表',
              },
            },
            required: ['name'],
          },
        },
      },
      execute: (args, ctx) => this.createAgent(args, ctx),
    },
  ];

  // =========================================================================
  // 实现
  // =========================================================================

  private async listAgents(
    args: Record<string, unknown>,
    ctx: PlatformToolContext,
  ): Promise<PlatformToolOutcome> {
    const keyword = asOptionalString(args.keyword);

    const agents = await this.prisma.agent.findMany({
      where: {
        OR: [{ isSystem: true }, { createdBy: ctx.userId }],
        ...(keyword
          ? { name: { contains: keyword, mode: 'insensitive' } }
          : {}),
      },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        name: true,
        description: true,
        type: true,
        isSystem: true,
        isDefault: true,
        status: true,
        workflowIds: true,
        knowledgeBaseIds: true,
        skillIds: true,
        mcpServerIds: true,
      },
    });

    if (agents.length === 0) {
      return {
        text: '没有符合条件的 Agent。',
        targetType: 'agent',
        summary: '查询 Agent（0 个）',
      };
    }

    const lines = agents.map((a) =>
      [
        `- ${a.name}｜id=${a.id}${a.isDefault ? '（平台默认）' : ''}`,
        `  类型=${AGENT_TYPE_LABELS[a.type] ?? a.type}｜状态=${a.status}｜系统=${
          a.isSystem ? '是' : '否'
        }`,
        `  绑定：工作流 ${a.workflowIds.length}｜知识库 ${a.knowledgeBaseIds.length}｜Skill ${a.skillIds.length}｜MCP ${a.mcpServerIds.length}`,
        a.description ? `  说明=${a.description}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );

    return {
      text: `共 ${agents.length} 个 Agent：\n${lines.join('\n')}`,
      targetType: 'agent',
      summary: `查询 Agent（${agents.length} 个）`,
    };
  }

  private async createAgent(
    args: Record<string, unknown>,
    ctx: PlatformToolContext,
  ): Promise<PlatformToolOutcome> {
    const name = asString(args.name);
    if (!name) {
      return {
        text: '错误：name 不能为空。',
        status: 'FAILED',
        summary: '缺少 Agent 名称',
      };
    }

    const type = asOptionalString(args.type) ?? 'CUSTOM';
    if (!Object.keys(AGENT_TYPE_LABELS).includes(type)) {
      return {
        text: `错误：不支持的 type「${type}」，可选：${Object.keys(AGENT_TYPE_LABELS).join(' / ')}。`,
        status: 'FAILED',
        summary: 'Agent 类型不合法',
      };
    }

    const workflowIds = asStringArray(args.workflowIds);
    const knowledgeBaseIds = asStringArray(args.knowledgeBaseIds);
    const skillIds = asStringArray(args.skillIds);
    const mcpServerIds = asStringArray(args.mcpServerIds);
    const llmModelId = asOptionalString(args.llmModelId);

    // ---- 逐个校验绑定资源归属（不允许绑定别人的资源）----
    const errors: string[] = [];

    if (workflowIds.length) {
      const owned = await this.prisma.workflow.findMany({
        where: {
          id: { in: workflowIds },
          workspace: {
            OR: [
              { ownerId: ctx.userId },
              { members: { some: { userId: ctx.userId } } },
            ],
          },
        },
        select: { id: true },
      });
      const ownedIds = new Set(owned.map((w) => w.id));
      for (const id of workflowIds) {
        if (!ownedIds.has(id)) errors.push(`工作流 ${id} 不存在或无权访问`);
      }
    }

    if (knowledgeBaseIds.length) {
      const owned = await this.prisma.knowledgeBase.findMany({
        where: { id: { in: knowledgeBaseIds }, ownerId: ctx.userId },
        select: { id: true },
      });
      const ownedIds = new Set(owned.map((k) => k.id));
      for (const id of knowledgeBaseIds) {
        if (!ownedIds.has(id)) errors.push(`知识库 ${id} 不存在或无权访问`);
      }
    }

    if (skillIds.length) {
      const owned = await this.prisma.skill.findMany({
        where: { id: { in: skillIds }, ownerId: ctx.userId },
        select: { id: true },
      });
      const ownedIds = new Set(owned.map((s) => s.id));
      for (const id of skillIds) {
        if (!ownedIds.has(id)) errors.push(`Skill ${id} 不存在或无权访问`);
      }
    }

    if (mcpServerIds.length) {
      const owned = await this.prisma.mcpServer.findMany({
        where: { id: { in: mcpServerIds }, ownerId: ctx.userId },
        select: { id: true },
      });
      const ownedIds = new Set(owned.map((m) => m.id));
      for (const id of mcpServerIds) {
        if (!ownedIds.has(id)) errors.push(`MCP Server ${id} 不存在或无权访问`);
      }
    }

    let modelName: string | null = null;
    if (llmModelId) {
      const ownedModelIds = await this.llmConfigService.listOwnedModelIds(
        ctx.userId,
      );
      if (!ownedModelIds.includes(llmModelId)) {
        errors.push(`模型配置 ${llmModelId} 不存在或无权访问`);
      } else {
        modelName = await this.llmConfigService.getModelName(llmModelId);
      }
    }

    if (errors.length > 0) {
      return {
        text: [
          '❌ 绑定资源校验未通过，**没有创建任何数据**：',
          ...errors.map((e) => `- ${e}`),
        ].join('\n'),
        status: 'FAILED',
        targetType: 'agent',
        targetName: name,
        summary: `创建 Agent 失败：${errors.length} 项资源不可用`,
      };
    }

    const workspace = await this.prisma.workspace.findFirst({
      where: {
        OR: [
          { ownerId: ctx.userId },
          { members: { some: { userId: ctx.userId } } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    const agent = await this.prisma.agent.create({
      data: {
        workspaceId: workspace?.id ?? null,
        createdBy: ctx.userId,
        name,
        description: asOptionalString(args.description),
        type,
        isDefault: false,
        isSystem: false,
        status: 'PUBLISHED',
        model: modelName ?? 'qwen2.5:7b',
        llmModelId,
        systemPrompt:
          asOptionalString(args.systemPrompt) ??
          '你是一个 AI 助手。请根据绑定的能力配置来帮助用户。',
        workflowIds,
        knowledgeBaseIds,
        skillIds,
        mcpServerIds,
        maxToolIterations: 10,
        temperature: 0.7,
      },
    });

    this.logger.log(
      `平台助理为用户 ${ctx.userId} 创建 Agent ${agent.id}（${name}）`,
    );

    return {
      text: [
        `✅ 已创建 Agent「${name}」（id=${agent.id}）`,
        `类型=${AGENT_TYPE_LABELS[type]}｜模型=${agent.model}`,
        `绑定：工作流 ${workflowIds.length}｜知识库 ${knowledgeBaseIds.length}｜Skill ${skillIds.length}｜MCP ${mcpServerIds.length}`,
        `配置入口：/agents/${agent.id}`,
      ].join('\n'),
      targetType: 'agent',
      targetId: agent.id,
      targetName: name,
      summary: `创建 Agent「${name}」`,
      link: `/agents/${agent.id}`,
    };
  }
}
