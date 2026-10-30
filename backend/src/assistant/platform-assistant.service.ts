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

/** 未绑定自定义模型时使用的本地 Ollama 默认模型 */
const DEFAULT_PLATFORM_MODEL = 'qwen2.5:7b';

/** 平台助理依赖工具调用，ReAct 迭代上限给足 */
const PLATFORM_ASSISTANT_MAX_TOOL_ITERATIONS = 12;

/**
 * 系统默认 Agent 的基线配置。
 *
 * 每个用户首次 ensure() 时按这份数据创建**自己的**一条记录 ——
 * 因此「配置最开始都一致」，之后谁改谁的，互不影响。
 * 集中在一处，避免「创建」与「历史迁移」两条路径的字段漂移。
 */
const PLATFORM_ASSISTANT_BASE_DATA = {
  workspaceId: null,
  name: PLATFORM_ASSISTANT_NAME,
  description: PLATFORM_ASSISTANT_DESCRIPTION,
  type: PLATFORM_ASSISTANT_AGENT_TYPE,
  isDefault: true,
  isSystem: true,
  status: 'PUBLISHED',
  model: DEFAULT_PLATFORM_MODEL,
  systemPrompt: PLATFORM_ASSISTANT_BASE_PROMPT,
  workflowIds: [] as string[],
  knowledgeBaseIds: [] as string[],
  skillIds: [] as string[],
  mcpServerIds: [] as string[],
  maxToolIterations: PLATFORM_ASSISTANT_MAX_TOOL_ITERATIONS,
  temperature: 0.3,
  enableFileGeneration: true,
};

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
 *
 * **隔离边界**：系统默认 Agent 每个用户一条（createdBy = 用户 id），
 * 模型配置、人格、会话、记忆都挂在这条记录上，改配置只对自己生效。
 * 所有读取入口都必须带 userId —— 不带 userId 的 find() 已不再提供，
 * 就是为了避免再写出「一份记录服务所有用户」的代码。
 */
@Injectable()
export class PlatformAssistantService {
  private readonly logger = new Logger(PlatformAssistantService.name);

  /** 历史共享记录的拆分只做一次（并发调用复用同一个 promise） */
  private legacyMigration?: Promise<void>;

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
   *
   * 传 userId 时同时校验归属：别人的系统默认 Agent 不算「我的」平台助理，
   * 否则用户 A 的配置会被当成用户 B 的来跑。
   */
  isPlatformAssistant(
    agent: {
      isSystem?: boolean | null;
      isDefault?: boolean | null;
      createdBy?: string | null;
    },
    userId?: string,
  ): boolean {
    if (agent?.isSystem !== true || agent?.isDefault !== true) return false;
    return userId === undefined || agent.createdBy === userId;
  }

  /** 读取当前用户的平台助理记录（不存在返回 null） */
  async find(userId: string) {
    return this.prisma.agent.findFirst({
      where: { isSystem: true, isDefault: true, createdBy: userId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** 读取当前用户的平台助理记录，不存在则抛 404 */
  async findOrFail(userId: string) {
    const agent = await this.find(userId);
    if (!agent) throw new NotFoundException('平台助理尚未初始化');
    return agent;
  }

  // ===========================================================================
  // 初始化（幂等）
  // ===========================================================================

  /**
   * 确保**当前用户**的平台助理存在。
   *
   * 每个用户一条独立记录：首次访问时按基线配置创建，
   * 之后该用户的模型配置 / 人格修改只写在自己的记录上。
   *
   * 注意：systemPrompt 在库里只存基础 Prompt，运行时会被
   * buildSystemPrompt 替换为「基础 Prompt + 动态上下文」。
   */
  async ensure(userId: string) {
    // 先把历史上那份「全局共享」的记录拆给各个用户（幂等，只会真正执行一次）
    try {
      await this.migrateLegacySharedAgent(userId);
    } catch (e) {
      // 拆分失败不能让对话打不开：本次按未拆分状态继续，下次访问重试
      this.logger.warn(
        `平台助理历史数据拆分失败，本次跳过：${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }

    const existing = await this.find(userId);
    if (existing) return this.repair(existing);

    try {
      const created = await this.prisma.agent.create({
        data: { ...PLATFORM_ASSISTANT_BASE_DATA, createdBy: userId },
      });
      this.logger.log(`为用户 ${userId} 创建平台助理 ${created.id}`);
      return created;
    } catch (e) {
      // 并发 ensure（列表与发消息同时打进来）会撞部分唯一索引，
      // 此时说明另一个请求已经建好了，回读即可。
      if (this.isUniqueViolation(e)) {
        const concurrent = await this.find(userId);
        if (concurrent) return concurrent;
      }
      throw e;
    }
  }

  /**
   * 把存量记录纠偏到当前版本（名称 / 描述 / Prompt 由系统维护）。
   *
   * 只改系统维护字段：模型配置（llmModelId / model / temperature）属于用户，
   * 一律不碰 —— 这正是本次改造要保住的东西。
   */
  private async repair(existing: {
    id: string;
    name: string;
    description: string | null;
    systemPrompt: string | null;
    type: string;
    status: string;
    maxToolIterations: number;
  }) {
    const needsUpgrade =
      existing.name !== PLATFORM_ASSISTANT_NAME ||
      existing.description !== PLATFORM_ASSISTANT_DESCRIPTION ||
      existing.systemPrompt !== PLATFORM_ASSISTANT_BASE_PROMPT ||
      existing.type !== PLATFORM_ASSISTANT_AGENT_TYPE ||
      existing.status !== 'PUBLISHED';

    if (!needsUpgrade) return existing;

    this.logger.log(`升级系统默认 Agent ${existing.id}「${existing.name}」`);
    return this.prisma.agent.update({
      where: { id: existing.id },
      data: {
        name: PLATFORM_ASSISTANT_NAME,
        description: PLATFORM_ASSISTANT_DESCRIPTION,
        type: PLATFORM_ASSISTANT_AGENT_TYPE,
        systemPrompt: PLATFORM_ASSISTANT_BASE_PROMPT,
        status: 'PUBLISHED',
        maxToolIterations: Math.max(
          existing.maxToolIterations,
          PLATFORM_ASSISTANT_MAX_TOOL_ITERATIONS,
        ),
      },
    });
  }

  /**
   * 历史数据迁移：把 `createdBy = NULL` 的全局共享平台助理拆成每用户一条。
   *
   * 为什么要拆：改造前所有用户的会话、记忆、人格都指向同一条记录，
   * 直接给记录加 createdBy 会让「第一个访问的人」独占所有人的历史。
   *
   * 步骤（幂等）：
   *   1. 找出该共享记录下有会话 / 记忆的用户
   *   2. 给每个这样的用户建一条自己的记录，沿用共享记录上的模型配置
   *      （迁移前所有人看到的就是这份配置，不继承会表现为「模型突然被重置」）
   *   3. 把该用户的 ChatSession / Memory / PlatformOperationLog 指向新记录
   *   4. 人格配置复制一份给新记录（人格原本也只有一份，所有人共用）
   *   5. 原共享记录降级为模板（isDefault=false），不再命中 isSystem && isDefault
   *
   * 迁移失败不阻断对话：抛错由调用方吞掉并记日志，下次访问重试。
   */
  private async migrateLegacySharedAgent(currentUserId: string): Promise<void> {
    if (this.legacyMigration) return this.legacyMigration;

    this.legacyMigration = this.doMigrateLegacySharedAgent(currentUserId)
      .then((settled) => {
        // 还有共享记录没拆完（例如当时还没有任何用户产生会话）→ 不缓存结果，
        // 下次访问再试，避免「第一次跑空就永久跳过」
        if (!settled) this.legacyMigration = undefined;
      })
      .catch((e) => {
        // 允许下次访问重试，否则一次数据库抖动会让迁移永久跳过
        this.legacyMigration = undefined;
        throw e;
      });

    return this.legacyMigration;
  }

  /**
   * @returns 是否已处理完毕（没有待拆分的共享记录时为 true）
   */
  private async doMigrateLegacySharedAgent(
    currentUserId: string,
  ): Promise<boolean> {
    let shared = await this.prisma.agent.findFirst({
      where: { isSystem: true, isDefault: true, createdBy: null },
      orderBy: { createdAt: 'asc' },
    });

    if (!shared) {
      // 更早版本遗留的默认助手：名字是 meibus / AWS，但没打 isDefault 标记。
      // 先补上标记，再走同一套按用户拆分流程。
      const legacy = await this.prisma.agent.findFirst({
        where: {
          isSystem: true,
          createdBy: null,
          name: { in: LEGACY_DEFAULT_AGENT_NAMES },
        },
        orderBy: { createdAt: 'asc' },
      });
      if (!legacy) return true;
      shared = await this.prisma.agent.update({
        where: { id: legacy.id },
        data: { isDefault: true },
      });
    }

    const [sessionOwners, memoryOwners, persona] = await Promise.all([
      this.prisma.chatSession.groupBy({
        by: ['userId'],
        where: { agentId: shared.id },
      }),
      this.prisma.memory.groupBy({
        by: ['userId'],
        where: { agentId: shared.id },
      }),
      this.prisma.agentPersona.findUnique({ where: { agentId: shared.id } }),
    ]);

    const ownerIds = [
      ...new Set([...sessionOwners, ...memoryOwners].map((row) => row.userId)),
    ];

    // 还没有任何用户在这条记录下产生会话 / 记忆 —— 说明它只是「初始化时建的空壳」。
    // 这时不需要复制，直接归属首个访问的用户即可（保留它上面的模型配置与人格），
    // 否则会留下一份永远没人用、又每次访问都要扫一遍的孤儿记录。
    if (ownerIds.length === 0) {
      const claimed = await this.prisma.agent.updateMany({
        where: { id: shared.id, createdBy: null },
        data: { createdBy: currentUserId },
      });
      if (claimed.count > 0) {
        this.logger.log(
          `平台助理共享记录 ${shared.id} 无历史数据，直接归属首个访问用户 ${currentUserId}`,
        );
        return true;
      }
      // 被并发请求抢先认领了：本次不缓存结果，下次按正常拆分流程走
      return false;
    }

    for (const userId of ownerIds) {
      const own = await this.prisma.agent.findFirst({
        where: { isSystem: true, isDefault: true, createdBy: userId },
        select: { id: true },
      });

      let targetId = own?.id;
      if (!targetId) {
        const created = await this.prisma.agent.create({
          data: {
            ...PLATFORM_ASSISTANT_BASE_DATA,
            createdBy: userId,
            // 沿用迁移前的模型配置，避免升级后表现成「模型被重置」
            model: shared.model,
            llmModelId: shared.llmModelId,
            temperature: shared.temperature,
            maxToolIterations: Math.max(
              shared.maxToolIterations,
              PLATFORM_ASSISTANT_MAX_TOOL_ITERATIONS,
            ),
          },
          select: { id: true },
        });
        targetId = created.id;

        if (persona) {
          await this.prisma.agentPersona.create({
            data: {
              agentId: targetId,
              name: persona.name,
              tags: persona.tags,
              systemPrompt: persona.systemPrompt,
              avatar: persona.avatar,
              voiceEnabled: persona.voiceEnabled,
              voiceId: persona.voiceId,
              speechRate: persona.speechRate,
              pitch: persona.pitch,
              desktopPetEnabled: persona.desktopPetEnabled,
              proactiveChatEnabled: persona.proactiveChatEnabled,
              proactiveChatFrequency: persona.proactiveChatFrequency,
              screenPerceptionEnabled: persona.screenPerceptionEnabled,
              screenPerceptionInterval: persona.screenPerceptionInterval,
              personaVersion: persona.personaVersion,
            },
          });
        }
      }

      await this.prisma.$transaction([
        this.prisma.chatSession.updateMany({
          where: { agentId: shared.id, userId },
          data: { agentId: targetId },
        }),
        this.prisma.memory.updateMany({
          where: { agentId: shared.id, userId },
          data: { agentId: targetId },
        }),
        this.prisma.platformOperationLog.updateMany({
          where: { agentId: shared.id, userId },
          data: { agentId: targetId },
        }),
      ]);
    }

    // 降级为模板：不再满足 isSystem && isDefault，也不会出现在任何用户的列表里。
    // 不删除是为了保留审计里可能出现的 targetId 引用。
    await this.prisma.agent.update({
      where: { id: shared.id },
      data: { isDefault: false },
    });

    this.logger.log(
      `平台助理已按用户拆分：共享记录 ${shared.id} → ${ownerIds.length} 个用户实例，原记录降级为模板`,
    );
    return true;
  }

  /** Prisma 唯一约束冲突（P2002）—— 并发 ensure 的预期结果，不是错误 */
  private isUniqueViolation(e: unknown): boolean {
    return (
      typeof e === 'object' &&
      e !== null &&
      (e as { code?: string }).code === 'P2002'
    );
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
