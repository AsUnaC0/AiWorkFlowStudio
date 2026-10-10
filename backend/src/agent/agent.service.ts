import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIService } from '../ai/ai.service';
import type { AiProvider, ChatMessage } from '../ai/ai-provider.interface';
import { parseToolArguments } from '../ai/tool-args.util';
import { LlmConfigService } from '../llm-config/llm-config.service';
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
  | {
      type: 'meta';
      agentId: string;
      agentName: string;
      model: string;
      provider: string;
    }
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

/** 未绑定自定义模型时使用的本地 Ollama 默认模型 */
const DEFAULT_LOCAL_MODEL = 'qwen2.5:7b';

/** 系统预设 Agent（启动时或首次访问时自动创建） */
const SYSTEM_AGENTS = [
  {
    name: 'meibus',
    description: '默认聊天助手',
    type: 'CUSTOM' as AgentType,
    isDefault: true,
    model: DEFAULT_LOCAL_MODEL,
    systemPrompt: '你是一个友好、专业的 AI 助手。直接回答用户问题即可。',
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
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiService: AIService,
    private readonly toolRegistry: ToolRegistry,
    private readonly llmConfigService: LlmConfigService,
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

    // 绑定自定义模型时，model 列存真实模型标识（如 deepseek-ai/DeepSeek-V4-Flash）；
    // 未绑定时回退本地默认模型。
    const llmModelId = dto.llmModelId?.trim() || null;
    const model = await this.resolveModelName(llmModelId, dto.model);

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
        model,
        llmModelId,
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

  /**
   * 根据 llmModelId 解析出要写入 `Agent.model` 的真实模型名。
   * - 有 llmModelId 且能查到 → 用模型标识（如 deepseek-ai/DeepSeek-V4-Flash）
   * - 有 llmModelId 但查不到 → 回退调用方传入的 fallback
   * - 无 llmModelId → 用 fallback（本地 Ollama 模型名），默认 DEFAULT_LOCAL_MODEL
   */
  private async resolveModelName(
    llmModelId: string | null,
    fallback?: string,
  ): Promise<string> {
    if (llmModelId) {
      const name = await this.llmConfigService.getModelName(llmModelId);
      if (name) return name;
    }
    return fallback?.trim() || DEFAULT_LOCAL_MODEL;
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

    const data: Record<string, unknown> = { ...dto };

    // llmModelId 传空字符串表示清除（回退本地默认 model）；undefined 表示不改。
    // 同时把 model 列同步为真实模型名，保证「模型名」字段始终正确。
    if (dto.llmModelId !== undefined) {
      const llmModelId = dto.llmModelId?.trim() || null;
      data.llmModelId = llmModelId;
      data.model = await this.resolveModelName(llmModelId, dto.model);
    }

    return this.prisma.agent.update({
      where: { id: agentId },
      data: data as never,
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

    this.logger.log(
      `run agent "${agent.name}" → tools=${tools.length} (workflowIds=${agent.workflowIds?.length ?? 0} kbIds=${agent.knowledgeBaseIds?.length ?? 0})` +
        (tools.length > 0
          ? ` [${tools.map((t) => t.function.name).join(', ')}]`
          : '（无工具可用——检查 workflowIds 是否已发布）'),
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

    // 4.5 解析运行时 Provider：优先用户所选自定义模型，否则回退全局 Ollama
    let chatBackend: AiProvider = this.aiService.getProvider();
    let chatModel = agent.model;
    if (agent.llmModelId) {
      const runtime = await this.llmConfigService.resolveModelRuntime(
        agent.llmModelId,
      );
      chatBackend = runtime.provider;
      chatModel = runtime.modelId;
    }

    // 4.6 把「本次实际使用的模型」推给前端 + 打日志，便于核对（避免"改了模型但感觉没生效"）
    this.logger.log(
      `run agent "${agent.name}"(${agent.id}) -> model="${chatModel}" provider=${chatBackend.name} llmModelId=${agent.llmModelId ?? 'null'}`,
    );
    yield {
      type: 'meta',
      agentId: agent.id,
      agentName: agent.name,
      model: chatModel,
      provider: chatBackend.name,
    };

    // 5. ReAct 循环
    let currentMessages = messages;
    const maxIters = agent.maxToolIterations;
    const allTrailSteps: Array<Record<string, unknown>> = [];
    const chatOptions = { model: chatModel, temperature: agent.temperature };

    // 5a. 无工具 → 直接用 streamChat 做 token 级流式（最常见的纯聊天场景）
    if (tools.length === 0) {
      yield { type: 'thinking', message: '思考中...' };
      allTrailSteps.push({ type: 'thinking', message: '思考中...' });

      let fullContent = '';
      for await (const token of chatBackend.streamChat(
        currentMessages,
        chatOptions,
      )) {
        fullContent += token;
        yield { type: 'message', content: fullContent };
      }

      if (options.sessionId && fullContent) {
        await this.prisma.chatMessage.create({
          data: {
            sessionId: options.sessionId,
            role: 'assistant',
            content: fullContent,
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

    // 5b. 有工具 → ReAct 循环（先用非流式 chatWithTools 判断 tool_calls）
    for (let i = 0; i < maxIters; i++) {
      yield { type: 'thinking', message: `思考中... (第 ${i + 1} 轮)` };
      allTrailSteps.push({
        type: 'thinking',
        message: `思考中... (第 ${i + 1} 轮)`,
      });

      const result = await chatBackend.chatWithTools(
        currentMessages,
        chatOptions,
        tools,
      );

      // LLM 直接回答 —— 用 streamChat 做最终流式输出
      if (result.toolCalls.length === 0) {
        // 如果 result.content 已有内容（LLM 直接给了答案），先快速 chunk 推送
        // 再用 streamChat 做真正的 token 级流式（体验更流畅）
        if (result.content) {
          // 立刻推送已有的 content（chunk 化模拟首次输出）
          yield { type: 'message', content: result.content };
        }

        // 用 streamChat 重新流式输出，用户能看到真正的打字机效果
        // 把最终 content 逐步累积 yield 给前端
        let streamedContent = '';
        for await (const token of chatBackend.streamChat(
          currentMessages,
          chatOptions,
        )) {
          streamedContent += token;
          yield { type: 'message', content: streamedContent };
        }

        const finalContent = streamedContent || result.content;
        if (options.sessionId && finalContent) {
          await this.prisma.chatMessage.create({
            data: {
              sessionId: options.sessionId,
              role: 'assistant',
              content: finalContent,
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
        // 兼容 arguments 为「JSON 字符串」或「对象」两种形态（后者见于部分 OpenAI 兼容服务）
        const args = parseToolArguments(tc.function.arguments);

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
