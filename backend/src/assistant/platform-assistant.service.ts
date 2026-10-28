import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { ToolDefinition } from '../ai/ai-provider.interface';
import {
  PlatformToolsService,
  type PlatformToolExecution,
} from '../platform-tools/platform-tools.service';
import type { PlatformToolContext } from '../platform-tools/platform-tool.interface';
import {
  PLATFORM_ASSISTANT_BASE_PROMPT,
  PLATFORM_ASSISTANT_DESCRIPTION,
  PLATFORM_ASSISTANT_NAME,
} from './platform-assistant.prompt';
import {
  composeSystemPromptWithExtras,
  toToolContext,
  type MemoryRecallItem,
  type PersonaSectionInput,
  type PlatformAssistantContext,
} from './platform-assistant.context';

/**
 * 平台助理的 Agent.type。
 *
 * 刻意沿用既有的 'CUSTOM' 而不是新增枚举值 —— 识别平台助理的依据是
 * 「isSystem && isDefault」这个事实（见 isPlatformAssistant），
 * 而不是 type。新增 type 会让前端已有的模板映射 / 表单分支全部要跟着改，
 * 收益为零。
 */
export const PLATFORM_ASSISTANT_AGENT_TYPE = 'CUSTOM';

/** 历史上默认系统 Agent 的旧名称（升级时用于原地迁移，避免出现两个默认助手） */
const LEGACY_DEFAULT_AGENT_NAMES = ['meibus', 'AWS'];

/**
 * PlatformAssistantService —— 平台助理的编排层。
 *
 * 它**不重新实现一套大模型调用引擎**，而是给既有的 AgentService.runStream()
 * 提供三样东西：
 *   1. 专属 System Prompt（身份 + 行为约束 + 动态上下文）
 *   2. 平台内置工具定义（来自 PlatformToolsService）
 *   3. 工具执行入口（带权限校验、审计与结构化结果）
 *
 * 平台助理 = 系统默认 Agent（isSystem && isDefault）+ 上述三样。
 * 因此普通用户创建的 Agent 完全不受影响。
 */
@Injectable()
export class PlatformAssistantService {
  private readonly logger = new Logger(PlatformAssistantService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformTools: PlatformToolsService,
  ) {}

  // ===========================================================================
  // 身份识别
  // ===========================================================================

  /**
   * 判断某个 Agent 是否为平台助理。
   * 判据是「系统默认 Agent」这个事实，而不是名字 —— 名字可以被改，标识不能。
   */
  isPlatformAssistant(agent: {
    isSystem?: boolean | null;
    isDefault?: boolean | null;
  }): boolean {
    return agent?.isSystem === true && agent?.isDefault === true;
  }

  /** 读取平台助理记录（不存在返回 null） */
  async find() {
    return this.prisma.agent.findFirst({
      where: { isSystem: true, isDefault: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** 读取平台助理记录，不存在则抛 404 */
  async findOrFail() {
    const agent = await this.find();
    if (!agent) throw new NotFoundException('平台助理尚未初始化');
    return agent;
  }

  // ===========================================================================
  // 初始化（幂等）
  // ===========================================================================

  /**
   * 确保平台助理存在。首次启动时创建；若存在历史的默认助手（meibus / AWS），
   * 则**原地升级**成平台助理（保留 id，会话历史不丢）。
   *
   * 注意：系统 Agent 的 systemPrompt 在库里只存基础 Prompt，
   * 运行时会被 composeSystemPrompt 替换为「基础 Prompt + 动态上下文」。
   */
  async ensure() {
    const existing = await this.prisma.agent.findFirst({
      where: { isSystem: true, isDefault: true },
      orderBy: { createdAt: 'asc' },
    });

    if (existing) {
      // 只在确实需要时更新，避免每次请求都写库
      const needsUpgrade =
        existing.name !== PLATFORM_ASSISTANT_NAME ||
        existing.description !== PLATFORM_ASSISTANT_DESCRIPTION ||
        existing.systemPrompt !== PLATFORM_ASSISTANT_BASE_PROMPT ||
        existing.type !== PLATFORM_ASSISTANT_AGENT_TYPE ||
        existing.status !== 'PUBLISHED';

      if (needsUpgrade) {
        this.logger.log(
          `升级系统默认 Agent ${existing.id}「${existing.name}」→ 平台助理`,
        );
        return this.prisma.agent.update({
          where: { id: existing.id },
          data: {
            name: PLATFORM_ASSISTANT_NAME,
            description: PLATFORM_ASSISTANT_DESCRIPTION,
            type: PLATFORM_ASSISTANT_AGENT_TYPE,
            systemPrompt: PLATFORM_ASSISTANT_BASE_PROMPT,
            status: 'PUBLISHED',
            // 平台助理依赖工具调用，迭代上限给足
            maxToolIterations: Math.max(existing.maxToolIterations, 12),
          },
        });
      }
      return existing;
    }

    // 兼容更早版本遗留的、非 isDefault 的系统助手（原地升级，不新建）
    const legacy = await this.prisma.agent.findFirst({
      where: {
        isSystem: true,
        name: { in: LEGACY_DEFAULT_AGENT_NAMES },
      },
      orderBy: { createdAt: 'asc' },
    });
    if (legacy) {
      this.logger.log(
        `迁移历史系统助手 ${legacy.id}「${legacy.name}」→ 平台助理`,
      );
      return this.prisma.agent.update({
        where: { id: legacy.id },
        data: {
          name: PLATFORM_ASSISTANT_NAME,
          description: PLATFORM_ASSISTANT_DESCRIPTION,
          type: PLATFORM_ASSISTANT_AGENT_TYPE,
          isDefault: true,
          status: 'PUBLISHED',
          systemPrompt: PLATFORM_ASSISTANT_BASE_PROMPT,
          maxToolIterations: Math.max(legacy.maxToolIterations, 12),
        },
      });
    }

    this.logger.log('创建平台助理（系统默认 Agent）');
    return this.prisma.agent.create({
      data: {
        workspaceId: null,
        createdBy: null,
        name: PLATFORM_ASSISTANT_NAME,
        description: PLATFORM_ASSISTANT_DESCRIPTION,
        type: PLATFORM_ASSISTANT_AGENT_TYPE,
        isDefault: true,
        isSystem: true,
        status: 'PUBLISHED',
        model: 'qwen2.5:7b',
        systemPrompt: PLATFORM_ASSISTANT_BASE_PROMPT,
        workflowIds: [],
        knowledgeBaseIds: [],
        skillIds: [],
        mcpServerIds: [],
        maxToolIterations: 12,
        temperature: 0.3,
        enableFileGeneration: true,
      },
    });
  }

  // ===========================================================================
  // 动态上下文
  // ===========================================================================

  /**
   * 构建运行上下文。
   *
   * @param userId     来自已验证认证上下文（不可由前端/模型覆盖）
   * @param workspaceId 前端可选的「当前工作空间」。这里会**重新校验成员关系**，
   *                   校验不通过就当作未指定，绝不直接采信。
   */
  async buildContext(
    userId: string,
    workspaceId?: string,
  ): Promise<PlatformAssistantContext> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, email: true },
    });

    const memberships = await this.prisma.workspace.findMany({
      where: {
        OR: [{ ownerId: userId }, { members: { some: { userId } } }],
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, ownerId: true },
    });

    const workspaces: Array<{
      id: string;
      name: string;
      role: 'OWNER' | 'MEMBER';
    }> = memberships.map((w) => ({
      id: w.id,
      name: w.name,
      role: w.ownerId === userId ? 'OWNER' : 'MEMBER',
    }));

    // 校验前端传来的 workspaceId —— 不是成员就当没传
    let currentWorkspaceId: string | undefined;
    if (workspaceId && workspaces.some((w) => w.id === workspaceId)) {
      currentWorkspaceId = workspaceId;
    } else if (workspaces.length === 1) {
      // 只有一个空间时直接采用，避免每次都要问用户
      currentWorkspaceId = workspaces[0].id;
    } else if (workspaceId) {
      this.logger.warn(
        `用户 ${userId} 请求的 workspaceId=${workspaceId} 校验失败（非成员），已忽略`,
      );
    }

    const currentWorkspaceName = workspaces.find(
      (w) => w.id === currentWorkspaceId,
    )?.name;

    return {
      userId,
      username: user?.username ?? '未知用户',
      email: user?.email ?? '',
      currentWorkspaceId,
      currentWorkspaceName,
      locale: 'zh-CN',
      workspaces,
      availableCapabilities: this.platformTools
        .listCapabilities()
        .map(
          (c) =>
            `${c.label}（${c.name}｜${c.riskLevel === 'HIGH' ? '高风险' : c.riskLevel === 'MEDIUM' ? '中风险' : '只读'}）`,
        ),
    };
  }

  // ===========================================================================
  // 工具
  // ===========================================================================

  /** 平台助理可用的工具定义（固定的一整套，与用户资源无关） */
  buildToolDefinitions(): ToolDefinition[] {
    return this.platformTools.buildDefinitions();
  }

  isPlatformTool(name: string): boolean {
    return this.platformTools.isPlatformTool(name);
  }

  /** 生成平台工具执行上下文（userId / workspaceId 全部来自服务端） */
  buildToolContext(
    ctx: PlatformAssistantContext,
    extra: { agentId: string; sessionId?: string },
  ): PlatformToolContext {
    return toToolContext(ctx, extra);
  }

  /** 执行平台工具（内部含权限校验、审计落库、异常兜底） */
  async executeTool(
    name: string,
    args: Record<string, unknown>,
    ctx: PlatformToolContext,
  ): Promise<PlatformToolExecution> {
    return this.platformTools.execute(name, args, ctx);
  }

  // ===========================================================================
  // Prompt
  // ===========================================================================

  /**
   * 装配本次运行的 System Prompt。
   *
   * 四段式（顺序不可调换，见 platform-assistant.context.ts）：
   *   平台职责与安全约束 → 人格表达层 → 记忆片段 → 动态执行上下文
   *
   * @param extras.persona  人格表达层（只有平台助理有，普通 Agent 传 undefined）
   * @param extras.memories 本次召回的记忆摘要（为空时不注入该段）
   */
  buildSystemPrompt(
    ctx: PlatformAssistantContext,
    extras?: {
      persona?: PersonaSectionInput;
      memories?: MemoryRecallItem[];
    },
  ): string {
    return composeSystemPromptWithExtras(
      PLATFORM_ASSISTANT_BASE_PROMPT,
      ctx,
      extras,
    );
  }
}
