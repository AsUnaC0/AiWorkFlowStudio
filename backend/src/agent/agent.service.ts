import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIService } from '../ai/ai.service';
import type { ChatMessage } from '../ai/ai-provider.interface';
import { ToolRegistry } from './tool-registry.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';

// ===========================================================================
// 类型
// ===========================================================================

export type AgentType =
  | 'GENERAL'
  | 'KNOWLEDGE'
  | 'WORKFLOW'
  | 'TOOL'
  | 'CUSTOM';
export type AgentStatus = 'DRAFT' | 'PUBLISHED' | 'DISABLED';

export type AgentStreamEvent =
  | { type: 'thinking'; message: string }
  | { type: 'tool_call'; tool: string; args: Record<string, unknown> }
  | { type: 'tool_result'; tool: string; result: string; durationMs: number }
  | { type: 'message'; content: string }
  | { type: 'error'; message: string };

export interface AgentRunOptions {
  input: string;
  agentId: string;
  sessionId?: string;
}

/** 系统预设 Agent（启动时或首次访问时自动创建） */
const SYSTEM_AGENTS = [
  {
    name: 'AWS',
    description:
      'AWS 云服务专家，帮助你查询和理解 AWS 服务、架构最佳实践、定价与安全合规。',
    type: 'CUSTOM' as AgentType,
    isDefault: true,
    model: 'qwen2.5:7b',
    systemPrompt:
      '你是一个 AWS 云服务专家助手。你可以帮助用户理解 AWS 服务、架构设计、最佳实践、定价和安全合规等问题。\n\n' +
      '当用户询问具体的 AWS 服务时，提供清晰、准确的说明。当用户需要架构建议时，结合 AWS Well-Architected Framework 给出建议。\n\n' +
      '如果问题超出你的知识范围，坦诚告知用户。',
  },
];

const USER_TEMPLATES: Record<AgentType, Partial<CreateAgentDto>> = {
  GENERAL: {
    name: '通用助手',
    description: '默认 Agent，可直接聊天，不绑定额外能力',
    systemPrompt: '你是一个友好、专业的 AI 助手。直接回答用户问题即可。',
  },
  KNOWLEDGE: {
    name: '知识库问答助手',
    description: '面向文档查询、企业知识问答、产品手册检索等场景',
    systemPrompt:
      '你是一个专业的知识库问答助手。请基于检索到的知识库内容回答用户问题。如果知识库中没有相关信息，请坦诚告知用户。',
  },
  WORKFLOW: {
    name: '工作流助手',
    description: '以执行工作流为主，适合数据处理、审批辅助、自动化任务等场景',
    systemPrompt:
      '你是一个工作流执行助手。当用户请求需要自动化处理时，调用绑定的工作流来完成任务。',
  },
  TOOL: {
    name: '工具型助手',
    description: '使用 MCP Server 工具、Skill 定义的专业任务能力',
    systemPrompt:
      '你是一个工具型助手。积极使用可用的 MCP 工具和 Skill 来帮助用户完成任务。',
  },
  CUSTOM: {
    name: '自定义 Agent',
    description: '自由组合模型、知识库、工作流、MCP 和 Skill',
    systemPrompt: '你是一个 AI 助手。请根据绑定的能力配置来帮助用户。',
  },
};

@Injectable()
export class AgentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiService: AIService,
    private readonly toolRegistry: ToolRegistry,
  ) {}

  // ===========================================================================
  // 系统初始化
  // ===========================================================================

  /**
   * 确保系统预设 Agent 存在（幂等，应用启动或首次访问时调用）。
   * AWS 是系统默认助手（isDefault=true, isSystem=true）。
   */
  async ensureSystemAgents() {
    for (const preset of SYSTEM_AGENTS) {
      const existing = await this.prisma.agent.findFirst({
        where: { isSystem: true, name: preset.name },
      });
      if (!existing) {
        await this.prisma.agent.create({
          data: {
            workspaceId: null,
            createdBy: null,
            name: preset.name,
            description: preset.description,
            type: preset.type,
            isDefault: preset.isDefault ?? false,
            isSystem: true,
            status: 'PUBLISHED',
            model: preset.model,
            systemPrompt: preset.systemPrompt,
            workflowIds: [],
            knowledgeBaseIds: [],
            skillIds: [],
            mcpServerIds: [],
            maxToolIterations: 10,
            temperature: 0.7,
          },
        });
      }
    }
  }

  // ===========================================================================
  // 权限判断
  // ===========================================================================

  private async canAccess(agentId: string, userId: string): Promise<boolean> {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
    });
    if (!agent) return false;
    return agent.isSystem || agent.createdBy === userId;
  }

  private async canModify(agentId: string, userId: string): Promise<boolean> {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
    });
    if (!agent) return false;
    // 系统 Agent 只有 creator=null 时才允许（即系统本身不可修改——但此处没有系统级 user，所以系统 Agent 不可修改）
    if (agent.isSystem) return false;
    return agent.createdBy === userId;
  }

  // ===========================================================================
  // Agent CRUD
  // ===========================================================================

  async list(userId: string) {
    // 确保系统 Agent 存在
    await this.ensureSystemAgents();

    return this.prisma.agent.findMany({
      where: {
        OR: [
          { isSystem: true }, // 系统预设 Agent 对所有人可见
          { createdBy: userId }, // 用户自己创建的 Agent
        ],
      },
      orderBy: [
        { isDefault: 'desc' }, // 默认助手（AWS）排最前面
        { isSystem: 'desc' },
        { createdAt: 'asc' },
      ],
    });
  }

  async findOne(userId: string, agentId: string) {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
    });
    if (!agent) throw new NotFoundException('Agent 不存在');
    if (!agent.isSystem && agent.createdBy !== userId) {
      throw new ForbiddenException('无权访问此 Agent');
    }
    return agent;
  }

  async create(userId: string, dto: CreateAgentDto) {
    const type = dto.type ?? 'CUSTOM';
    const template = USER_TEMPLATES[type];

    // 用户创建的 Agent 关联到一个 workspace（取第一个），也可以不传 workspaceId
    const workspace = await this.prisma.workspace.findFirst({
      where: { ownerId: userId },
      orderBy: { createdAt: 'asc' },
    });

    return this.prisma.agent.create({
      data: {
        workspaceId: workspace?.id ?? null,
        createdBy: userId,
        name: dto.name ?? template.name ?? '新 Agent',
        description: dto.description ?? template.description,
        avatar: dto.avatar,
        type,
        isDefault: false,
        isSystem: false,
        status: 'PUBLISHED',
        model: dto.model ?? 'qwen2.5:7b',
        systemPrompt: dto.systemPrompt ?? template.systemPrompt,
        workflowIds: dto.workflowIds ?? [],
        knowledgeBaseIds: dto.knowledgeBaseIds ?? [],
        skillIds: dto.skillIds ?? [],
        mcpServerIds: dto.mcpServerIds ?? [],
        maxToolIterations: dto.maxToolIterations ?? 10,
        temperature: dto.temperature ?? 0.7,
      },
    });
  }

  async update(userId: string, agentId: string, dto: UpdateAgentDto) {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
    });
    if (!agent) throw new NotFoundException('Agent 不存在');

    if (agent.isSystem) {
      throw new BadRequestException('系统预设 Agent 不允许修改');
    }
    if (agent.createdBy !== userId) {
      throw new ForbiddenException('无权修改此 Agent');
    }

    return this.prisma.agent.update({
      where: { id: agentId },
      data: dto,
    });
  }

  async remove(userId: string, agentId: string) {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
    });
    if (!agent) throw new NotFoundException('Agent 不存在');

    if (agent.isSystem) {
      throw new BadRequestException('系统预设 Agent 不允许删除');
    }
    if (agent.createdBy !== userId) {
      throw new ForbiddenException('无权删除此 Agent');
    }

    return this.prisma.agent.delete({ where: { id: agentId } });
  }

  // ===========================================================================
  // 资源查询
  // ===========================================================================

  async getAvailableResources(userId: string) {
    const [workflows, knowledgeBases, skills, mcpServers] = await Promise.all([
      this.prisma.workflow.findMany({
        where: {
          status: 'PUBLISHED',
          workspace: {
            OR: [{ ownerId: userId }, { members: { some: { userId } } }],
          },
        },
        select: {
          id: true,
          name: true,
          description: true,
          publishedVersion: { select: { version: true } },
        },
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.knowledgeBase.findMany({
        where: {
          OR: [
            { ownerId: userId },
            {
              workspaces: {
                some: {
                  workspace: {
                    OR: [
                      { ownerId: userId },
                      { members: { some: { userId } } },
                    ],
                  },
                },
              },
            },
          ],
        },
        select: {
          id: true,
          name: true,
          description: true,
          documentCount: true,
          chunkCount: true,
        },
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.skill.findMany({
        where: { ownerId: userId },
        select: { id: true, name: true, description: true, type: true },
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.mcpServer.findMany({
        where: { ownerId: userId },
        select: { id: true, name: true, description: true, status: true },
        orderBy: { updatedAt: 'desc' },
      }),
    ]);

    return { workflows, knowledgeBases, skills, mcpServers };
  }

  // ===========================================================================
  // ReAct 循环
  // ===========================================================================

  async *runStream(
    userId: string,
    options: AgentRunOptions,
    history?: ChatMessage[],
  ): AsyncGenerator<AgentStreamEvent> {
    // 1. 读取 Agent + 权限
    await this.ensureSystemAgents();
    const agent = await this.findOne(userId, options.agentId);
    if (agent.status === 'DISABLED') {
      yield { type: 'error', message: '该 Agent 已被禁用' };
      return;
    }

    // 2. 准备消息
    const messages: ChatMessage[] = [];
    if (agent.systemPrompt) {
      messages.push({ role: 'system', content: agent.systemPrompt });
    }
    if (history?.length) {
      messages.push(...history);
    }
    messages.push({ role: 'user', content: options.input });

    // 3. 工具
    const tools = await this.toolRegistry.buildDefinitions(
      agent.workflowIds,
      agent.knowledgeBaseIds,
    );

    // 4. 持久化用户消息
    if (options.sessionId) {
      await this.prisma.chatMessage.create({
        data: {
          sessionId: options.sessionId,
          role: 'user',
          content: options.input,
        },
      });
      await this.prisma.chatSession.update({
        where: { id: options.sessionId },
        data: { updatedAt: new Date() },
      });
    }

    // 5. ReAct 循环
    let currentMessages = messages;
    const maxIters = agent.maxToolIterations;
    const allTrailSteps: Array<Record<string, unknown>> = [];

    for (let i = 0; i < maxIters; i++) {
      yield { type: 'thinking', message: `思考中... (第 ${i + 1} 轮)` };
      allTrailSteps.push({
        type: 'thinking',
        message: `思考中... (第 ${i + 1} 轮)`,
      });

      const result = await this.aiService.chatWithTools(
        currentMessages,
        { model: agent.model, temperature: agent.temperature },
        tools,
      );

      // LLM 直接回答
      if (result.toolCalls.length === 0) {
        yield { type: 'message', content: result.content };

        if (options.sessionId) {
          await this.prisma.chatMessage.create({
            data: {
              sessionId: options.sessionId,
              role: 'assistant',
              content: result.content,
              trail:
                allTrailSteps.length > 0 ? (allTrailSteps as any) : undefined,
            },
          });
          await this.prisma.chatSession.update({
            where: { id: options.sessionId },
            data: { updatedAt: new Date() },
          });
        }
        return;
      }

      // 有 tool_calls → 持久化 + 执行 + 喂回
      currentMessages.push({
        role: 'assistant',
        content: result.content,
        tool_calls: result.toolCalls,
      });

      if (options.sessionId) {
        await this.prisma.chatMessage.create({
          data: {
            sessionId: options.sessionId,
            role: 'assistant',
            content: result.content || '',
            toolCalls: result.toolCalls as any,
          },
        });
      }

      for (const tc of result.toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = { raw: tc.function.arguments };
        }

        yield { type: 'tool_call', tool: tc.function.name, args };
        allTrailSteps.push({ type: 'tool_call', tool: tc.function.name, args });

        const toolStart = Date.now();
        let toolResult = '';
        try {
          toolResult = await this.toolRegistry.executeTool(
            tc.function.name,
            args,
            {
              agentId: agent.id,
              userId,
              knowledgeBaseIds: agent.knowledgeBaseIds,
            },
          );
        } catch (err) {
          toolResult = `工具执行错误：${err instanceof Error ? err.message : String(err)}`;
        }
        const durationMs = Date.now() - toolStart;

        yield {
          type: 'tool_result',
          tool: tc.function.name,
          result: toolResult,
          durationMs,
        };
        allTrailSteps.push({
          type: 'tool_result',
          tool: tc.function.name,
          result: toolResult,
          durationMs,
        });

        if (options.sessionId) {
          await this.prisma.chatMessage.create({
            data: {
              sessionId: options.sessionId,
              role: 'tool',
              content: toolResult,
              toolCallId: tc.id,
            },
          });
        }

        currentMessages.push({
          role: 'tool',
          content: toolResult,
          tool_call_id: tc.id,
        });
      }
    }

    yield { type: 'error', message: 'Agent 达到最大工具调用次数限制' };
    if (options.sessionId) {
      await this.prisma.chatMessage.create({
        data: {
          sessionId: options.sessionId,
          role: 'assistant',
          content: '⚠️ Agent 达到最大工具调用次数限制',
          trail: allTrailSteps.length > 0 ? (allTrailSteps as any) : undefined,
        },
      });
    }
  }
}
