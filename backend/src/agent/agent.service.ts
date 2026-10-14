import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIService } from '../ai/ai.service';
import type {
  AiProvider,
  ChatMessage,
  ChatImage,
  ToolDefinition,
} from '../ai/ai-provider.interface';
import { parseToolArguments } from '../ai/tool-args.util';
import { LlmConfigService } from '../llm-config/llm-config.service';
import { McpService } from '../mcp/mcp.service';
import { McpToolService, type McpToolBinding } from '../mcp/mcp-tool.service';
import { FilesService } from '../files/files.service';
import { ChatFilesService } from '../chat-files/chat-files.service';
import { FileContextService } from '../chat-files/file-context.service';
import type { ChatAttachmentLike } from '../chat-files/parsers/parser.types';
import { ToolRegistry } from './tool-registry.service';
import type { GeneratedFileRef } from './tools/agent-tool.interface';
import { PlatformAssistantService } from '../assistant/platform-assistant.service';
import type { PlatformAssistantContext } from '../assistant/platform-assistant.context';
import type { PlatformToolContext } from '../platform-tools/platform-tool.interface';
import type { PlatformOperationPayload } from '../platform-tools/platform-tools.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';

// ===========================================================================
// 类型
// ===========================================================================

export type AgentType =
  'GENERAL' | 'KNOWLEDGE' | 'WORKFLOW' | 'TOOL' | 'CUSTOM';
export type AgentStatus = 'DRAFT' | 'PUBLISHED' | 'DISABLED';

export type AgentStreamEvent =
  | {
      type: 'meta';
      agentId: string;
      agentName: string;
      model: string;
      provider: string;
      /** 是否为平台助理（前端据此渲染「平台助理」标识） */
      isPlatformAssistant?: boolean;
    }
  | { type: 'thinking'; message: string }
  | { type: 'tool_call'; tool: string; args: Record<string, unknown> }
  | { type: 'tool_result'; tool: string; result: string; durationMs: number }
  /** 平台助理执行了一次平台操作（前端渲染操作卡片：风险等级 / 目标资源 / 跳转链接） */
  | { type: 'operation'; operation: PlatformOperationPayload }
  /** Agent 通过 generate_file 工具产出的文件（前端渲染为文件卡片） */
  | { type: 'file'; file: AgentFilePayload }
  | { type: 'message'; content: string }
  | { type: 'error'; message: string };

/** 推送给前端的文件卡片数据（序列化安全） */
export interface AgentFilePayload {
  id: string;
  fileName: string;
  format: string;
  extension: string;
  mimeType: string;
  size: number;
  status: string;
  previewType: string;
  title: string | null;
  summary: string | null;
  sourceType: string;
  createdAt: string;
}

export interface AgentRunOptions {
  input: string;
  agentId: string;
  sessionId?: string;
  /** 本次消息携带的聊天附件 ID（用户上传给模型阅读的文件） */
  attachmentIds?: string[];
  /**
   * 当前工作空间 ID（可选）。
   * 只作为「用户意图」传入：后端会重新校验成员关系后才采用，
   * 校验不通过则忽略（见 PlatformAssistantService.buildContext）。
   */
  workspaceId?: string;
}

/** 未绑定自定义模型时使用的本地 Ollama 默认模型 */
const DEFAULT_LOCAL_MODEL = 'qwen2.5:7b';

/**
 * 系统预设 Agent 允许用户修改的字段白名单 —— 只放开「模型配置」。
 *
 * 系统 Agent（平台助理）的名称 / 描述 / System Prompt / 绑定资源由系统维护
 * （ensure() 会在每次访问时把它们纠正回来），改了也没有意义；
 * 但模型配置必须放开：用户可能接的是自己的模型服务，
 * 需要能决定默认助手到底用哪个模型、什么温度。
 */
const SYSTEM_AGENT_EDITABLE_FIELDS = [
  'llmModelId',
  'model',
  'temperature',
] as const;

/**
 * 系统预设 Agent。
 *
 * 注：默认聊天助手已升级为「平台助理」，由 PlatformAssistantService.ensure()
 * 统一创建 / 迁移（它需要同时维护专属 Prompt 与工具注册，放在这里会造成职责分裂）。
 * 因此这里不再重复声明默认 Agent。
 */

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
    private readonly filesService: FilesService,
    private readonly chatFiles: ChatFilesService,
    private readonly fileContext: FileContextService,
    private readonly mcpService: McpService,
    private readonly mcpToolService: McpToolService,
    /** 平台助理（默认系统 Agent 的专属 Prompt / 平台工具 / 审计） */
    private readonly platformAssistant: PlatformAssistantService,
  ) {}

  /** 把 GeneratedFileRef 转成可 JSON 序列化的 SSE 载荷 */
  private toFilePayload(file: GeneratedFileRef): AgentFilePayload {
    return {
      id: file.id,
      fileName: file.fileName,
      format: file.format,
      extension: file.extension,
      mimeType: file.mimeType,
      size: file.size,
      status: file.status,
      previewType: file.previewType,
      title: file.title,
      summary: file.summary,
      sourceType: file.sourceType,
      createdAt:
        file.createdAt instanceof Date
          ? file.createdAt.toISOString()
          : String(file.createdAt),
    };
  }

  // ===========================================================================
  // 系统初始化
  // ===========================================================================

  /**
   * 确保系统预设 Agent 存在（幂等，应用启动或首次访问时调用）。
   *
   * 现在只有「平台助理」一个系统 Agent，且它的创建 / 历史迁移由
   * PlatformAssistantService.ensure() 负责（那里同时维护专属 Prompt 与工具注册）。
   */
  async ensureSystemAgents() {
    await this.platformAssistant.ensure();
  }

  // ===========================================================================
  // Agent CRUD
  // ===========================================================================
  //
  // 权限约定（直接内联在各自方法里，不抽公共布尔方法 —— 三处规则并不相同）：
  //   可见（list / findOne）：isSystem 或 createdBy === userId
  //   修改（update）：系统 Agent 只允许改模型配置（见 SYSTEM_AGENT_EDITABLE_FIELDS），
  //                  用户 Agent 要求 createdBy === userId
  //   删除（remove）：系统 Agent 一律不允许
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

    let data: Record<string, unknown>;

    if (agent.isSystem) {
      // 系统预设 Agent：只放开模型配置（见 SYSTEM_AGENT_EDITABLE_FIELDS），
      // 其余字段一律拒绝并明确告知调用方。
      // 注意 createdBy 为 null（系统创建），因此这里不做归属校验。
      const provided = Object.entries(dto as Record<string, unknown>).filter(
        ([, value]) => value !== undefined,
      );
      const rejected = provided
        .map(([key]) => key)
        .filter(
          (key) =>
            !(SYSTEM_AGENT_EDITABLE_FIELDS as readonly string[]).includes(key),
        );
      if (rejected.length > 0) {
        throw new BadRequestException(
          `系统预设 Agent 仅允许修改模型配置（${SYSTEM_AGENT_EDITABLE_FIELDS.join(
            ' / ',
          )}），不支持修改：${rejected.join('、')}`,
        );
      }
      data = Object.fromEntries(provided);
    } else {
      if (agent.createdBy !== userId) {
        throw new ForbiddenException('无权修改此 Agent');
      }
      data = { ...dto };
    }

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

    // 2. 解析运行时 Provider（优先用户自定义模型，否则回退全局 Ollama）
    //    平台助理是「一份记录服务所有用户」，因此它不绑定固定模型：
    //    运行时按当前用户的默认对话模型解析，找不到才回退全局 Ollama。
    const isPlatformAssistant =
      this.platformAssistant.isPlatformAssistant(agent);
    let chatBackend: AiProvider = this.aiService.getProvider();
    let chatModel = agent.model;
    if (agent.llmModelId) {
      const runtime = await this.llmConfigService.resolveModelRuntime(
        agent.llmModelId,
      );
      chatBackend = runtime.provider;
      chatModel = runtime.modelId;
    } else if (isPlatformAssistant) {
      const preferred =
        await this.llmConfigService.resolveUserDefaultChatModel(userId);
      if (preferred) {
        chatBackend = preferred.provider;
        chatModel = preferred.modelName;
      }
    }

    // 2.1 平台助理上下文：userId 来自已验证的认证上下文，
    //     workspaceId 由后端重新校验成员关系后才采信（模型无权覆盖）
    let assistantContext: PlatformAssistantContext | undefined;
    let platformToolContext: PlatformToolContext | undefined;
    if (isPlatformAssistant) {
      assistantContext = await this.platformAssistant.buildContext(
        userId,
        options.workspaceId,
      );
      platformToolContext = this.platformAssistant.buildToolContext(
        assistantContext,
        { agentId: agent.id, sessionId: options.sessionId },
      );
    }

    // 3. 处理附件：校验归属与解析状态，组装上下文（图片走视觉通道）
    let currentUserImages: ChatImage[] | undefined;
    let currentUserContent = options.input;
    let attachmentError: string | null = null;

    if (options.attachmentIds?.length) {
      try {
        const attachments = await this.chatFiles.resolveForChat(
          userId,
          options.attachmentIds,
          options.sessionId,
        );
        const ctx = await this.fileContext.build({
          question: options.input,
          attachments,
          model: chatModel,
          userId,
        });
        currentUserContent = ctx.text || options.input;
        if (ctx.images.length) currentUserImages = ctx.images;
      } catch (e) {
        attachmentError = e instanceof Error ? e.message : '附件处理失败';
      }
    }

    // 4. 组装消息：system + 历史（含历史附件上下文）+ 当前用户回合
    //    平台助理的 System Prompt = 专属身份规则 + 服务端注入的动态上下文，
    //    因此这里覆盖库里存的静态 systemPrompt。
    const messages: ChatMessage[] = [];
    const systemPrompt = assistantContext
      ? this.platformAssistant.buildSystemPrompt(assistantContext)
      : agent.systemPrompt;
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    if (history?.length) {
      messages.push(
        ...(await this.augmentHistoryWithAttachments(
          history,
          userId,
          options.sessionId,
        )),
      );
    }
    messages.push({
      role: 'user',
      content: currentUserContent,
      ...(currentUserImages ? { images: currentUserImages } : {}),
    });

    // 5. 工具（generate_file 为内置能力，由 Agent.enableFileGeneration 控制）
    const tools: ToolDefinition[] = await this.toolRegistry.buildDefinitions(
      agent.workflowIds,
      agent.knowledgeBaseIds,
      { enableFileGeneration: agent.enableFileGeneration !== false },
    );

    // 5.0 平台助理专属工具：整套平台内置工具，由后端注册（用户无法临时定义）。
    //     与 Agent 绑定的资源工具互不影响 —— 普通 Agent 拿不到这些工具。
    if (isPlatformAssistant) {
      const platformDefs = this.platformAssistant.buildToolDefinitions();
      tools.push(...platformDefs);
      this.logger.log(
        `平台助理加载 ${platformDefs.length} 个平台工具（用户 ${userId}，工作空间 ${
          assistantContext?.currentWorkspaceId ?? '未指定'
        }）`,
      );
    }

    // 5.1 MCP 工具：按 Agent 配置筛选（不做「所有 MCP 工具无差别塞给模型」）
    let mcpBindings = new Map<string, McpToolBinding>();
    if (Array.isArray(agent.mcpServerIds) && agent.mcpServerIds.length > 0) {
      const servers = await this.mcpService.findRuntimeConfigs(
        agent.mcpServerIds,
      );
      const built = await this.mcpToolService.buildBindings(servers);
      tools.push(...built.tools);
      mcpBindings = built.bindings;
      if (built.tools.length > 0) {
        this.logger.log(
          `agent "${agent.name}" 加载 ${built.tools.length} 个 MCP 工具（来自 ${servers.length} 个 Server）`,
        );
      }
    }

    // 3.5 本次运行生成的文件收集器（generate_file 工具会往里 push）
    const runFiles: GeneratedFileRef[] = [];
    let emittedFileCount = 0;
    const flushFileEvents = (): AgentStreamEvent[] => {
      const events: AgentStreamEvent[] = [];
      while (emittedFileCount < runFiles.length) {
        const file = runFiles[emittedFileCount];
        const payload = this.toFilePayload(file);
        events.push({ type: 'file', file: payload });
        allTrailSteps.push({ type: 'file', file: payload });
        emittedFileCount++;
      }
      return events;
    };

    // 4. 持久化用户消息（保留用户原始问题；附件另行关联到该消息）
    let userMessageId: string | undefined;
    if (options.sessionId) {
      const created = await this.prisma.chatMessage.create({
        data: {
          sessionId: options.sessionId,
          role: 'user',
          content: options.input,
        },
      });
      userMessageId = created.id;
      await this.prisma.chatSession.update({
        where: { id: options.sessionId },
        data: { updatedAt: new Date() },
      });
      if (options.attachmentIds?.length) {
        await this.chatFiles.attachToMessage(
          userId,
          options.attachmentIds,
          created.id,
          options.sessionId,
        );
      }
    }

    // 附件解析失败：保留用户消息，但回报错误并结束本轮
    if (attachmentError) {
      yield { type: 'error', message: attachmentError };
      return;
    }

    // 4.5 把「本次实际使用的模型」推给前端 + 打日志，便于核对（避免"改了模型但感觉没生效"）
    this.logger.log(
      `run agent "${agent.name}"(${agent.id}) -> model="${chatModel}" provider=${chatBackend.name} llmModelId=${agent.llmModelId ?? 'null'}`,
    );
    yield {
      type: 'meta',
      agentId: agent.id,
      agentName: agent.name,
      model: chatModel,
      provider: chatBackend.name,
      isPlatformAssistant,
    };

    // 5. ReAct 循环
    const currentMessages = messages;
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
        await this.persistAssistantMessage(
          options.sessionId,
          fullContent,
          allTrailSteps,
          runFiles,
        );
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
          await this.persistAssistantMessage(
            options.sessionId,
            finalContent,
            allTrailSteps,
            runFiles,
          );
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
        let operationPayload: PlatformOperationPayload | undefined;
        try {
          // 平台工具优先：只有平台助理拿得到这些工具定义，
          // 执行一律经 PlatformAssistantService（权限校验 + 审计 + 异常兜底）
          if (
            platformToolContext &&
            this.platformAssistant.isPlatformTool(tc.function.name)
          ) {
            const execution = await this.platformAssistant.executeTool(
              tc.function.name,
              args,
              platformToolContext,
            );
            toolResult = execution.text;
            operationPayload = execution.operation;
          } else {
            // MCP 工具：按 binding 路由到对应 Server（会话由连接层复用）
            const binding = mcpBindings.get(tc.function.name);
            if (binding) {
              const outcome = await this.mcpToolService.callTool(binding, args);
              toolResult = outcome.text;
            } else {
              toolResult = await this.toolRegistry.executeTool(
                tc.function.name,
                args,
                {
                  agentId: agent.id,
                  userId,
                  sessionId: options.sessionId,
                  files: runFiles,
                  knowledgeBaseIds: agent.knowledgeBaseIds,
                },
              );
            }
          }
        } catch (err) {
          toolResult = `工具执行错误：${err instanceof Error ? err.message : String(err)}`;
        }
        const durationMs = Date.now() - toolStart;

        // 工具可能产出了文件（generate_file）——立刻推给前端渲染卡片
        for (const event of flushFileEvents()) {
          yield event;
        }

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

        // 平台操作卡片：真实执行结果 + 风险等级 + 目标资源 + 入口链接
        if (operationPayload) {
          yield { type: 'operation', operation: operationPayload };
          allTrailSteps.push({
            type: 'operation',
            operation: operationPayload,
          });
        }

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
      await this.persistAssistantMessage(
        options.sessionId,
        '⚠️ Agent 达到最大工具调用次数限制',
        allTrailSteps,
        runFiles,
      );
    }
  }

  /**
   * 持久化 assistant 消息，并把本次运行生成的文件关联到该消息。
   *
   * 只有文件真正生成 + 落库成功才会出现在 runFiles 里，
   * 因此前端看到的 READY 状态一定对应一个可预览、可下载的真实文件。
   */
  private async persistAssistantMessage(
    sessionId: string,
    content: string,
    trail: Array<Record<string, unknown>>,
    files: GeneratedFileRef[],
  ) {
    const message = await this.prisma.chatMessage.create({
      data: {
        sessionId,
        role: 'assistant',
        content,
        trail: trail.length > 0 ? (trail as any) : undefined,
      },
    });

    if (files.length > 0) {
      await this.filesService.attachToMessage(
        files.map((f) => f.id),
        message.id,
      );
    }

    await this.prisma.chatSession.update({
      where: { id: sessionId },
      data: { updatedAt: new Date() },
    });

    return message;
  }

  /**
   * 把历史用户消息里附带的附件上下文重新注入。
   * 这样即使是「上传文件 → 后续追问」的多轮对话，模型也能持续引用文件内容。
   */
  private async augmentHistoryWithAttachments(
    history: ChatMessage[],
    userId: string,
    sessionId?: string,
  ): Promise<ChatMessage[]> {
    if (!sessionId) return history;

    const map = await this.chatFiles.getAttachmentsByMessages(
      userId,
      sessionId,
    );
    if (map.size === 0) return history;

    return history.map((m) => {
      const messageId = (m as ChatMessage & { id?: string }).id;
      const attachments = messageId ? map.get(messageId) : undefined;
      if (m.role === 'user' && attachments?.length) {
        return {
          ...m,
          content: m.content + this.fileContext.buildHistoryBlock(attachments),
        };
      }
      return m;
    });
  }
}
