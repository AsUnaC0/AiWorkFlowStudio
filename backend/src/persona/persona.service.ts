import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdatePersonaDto } from './dto/update-persona.dto';
import {
  DEFAULT_PERSONA_NAME,
  DEFAULT_PERSONA_PROMPT,
  DEFAULT_PERSONA_TAGS,
  MIN_PERCEPTION_INTERVAL,
} from './persona.prompt';

/**
 * 人格解析结果 —— 一定是「可用的完整值」，缺字段用默认值补齐。
 *
 * 之所以不直接返回 Prisma 记录：首次使用时数据库里可能还没有这条记录，
 * 但调用方（Prompt 装配 / 前端展示）不应该为「有没有记录」写分支。
 */
export interface ResolvedPersona {
  name: string;
  tags: string[];
  systemPrompt: string;
  avatar: string | null;
  voiceEnabled: boolean;
  voiceId: string;
  speechRate: number;
  pitch: number;
  desktopPetEnabled: boolean;
  proactiveChatEnabled: boolean;
  proactiveChatFrequency: string;
  screenPerceptionEnabled: boolean;
  screenPerceptionInterval: number;
  personaVersion: number;
  /** false 表示当前用的是内存默认值，数据库里还没有记录 */
  persisted: boolean;
  updatedAt: string | null;
}

/**
 * PersonaService —— 平台助理的人格配置。
 *
 * 权限边界（需求 2.1）：**只有系统默认助理**（isSystem && isDefault）有人格配置，
 * 用户自建 Agent 一律 403。这条校验放在 Service 层，不依赖前端隐藏按钮。
 *
 * 依赖方向：本模块**不** import AssistantModule —— 判定「是不是平台助理」直接查
 * Agent 的 isSystem / isDefault 两个字段，避免 Assistant ↔ Persona 循环依赖。
 */
@Injectable()
export class PersonaService {
  private readonly logger = new Logger(PersonaService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ===========================================================================
  // 默认值
  // ===========================================================================

  /** 内存态默认人格（未落库时使用） */
  private defaultPersona(): ResolvedPersona {
    return {
      name: DEFAULT_PERSONA_NAME,
      tags: [...DEFAULT_PERSONA_TAGS],
      systemPrompt: DEFAULT_PERSONA_PROMPT,
      avatar: null,
      voiceEnabled: true,
      voiceId: 'zh-CN-XiaoyiNeural',
      speechRate: 1.0,
      pitch: 1.0,
      desktopPetEnabled: false,
      proactiveChatEnabled: false,
      proactiveChatFrequency: 'low',
      screenPerceptionEnabled: false,
      screenPerceptionInterval: 60,
      personaVersion: 1,
      persisted: false,
      updatedAt: null,
    };
  }

  // ===========================================================================
  // 权限
  // ===========================================================================

  /**
   * 校验 agentId 确实指向**当前用户的**平台助理（系统默认 Agent）。
   *
   * 用「isSystem && isDefault」这个事实判定，而不是名字 —— 名字可以被人格改，
   * 标识不能。与 PlatformAssistantService.isPlatformAssistant 保持同一判据。
   *
   * 归属校验不可省：系统默认 Agent 每个用户一条，缺了它用户 A 能改用户 B 的人格。
   */
  private async assertPlatformAssistant(agentId: string, userId: string) {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: {
        id: true,
        name: true,
        isSystem: true,
        isDefault: true,
        createdBy: true,
      },
    });
    if (!agent) throw new NotFoundException('Agent 不存在');
    if (!agent.isSystem || !agent.isDefault) {
      throw new ForbiddenException('人格配置仅对平台默认助理开放');
    }
    if (agent.createdBy !== userId) {
      throw new ForbiddenException('无权修改此 Agent');
    }
    return agent;
  }

  // ===========================================================================
  // 读取
  // ===========================================================================

  /**
   * 解析某个人格配置（运行时用）。
   *
   * 刻意不做「读时创建」—— 只是读一下就写库会让每次对话都产生一次写入，
   * 而默认值本身是稳定的常量，直接用即可。
   */
  async resolveForAgent(agentId: string): Promise<ResolvedPersona> {
    const record = await this.prisma.agentPersona.findUnique({
      where: { agentId },
    });
    if (!record) return this.defaultPersona();

    return {
      name: record.name,
      tags: record.tags,
      systemPrompt: record.systemPrompt,
      avatar: record.avatar,
      voiceEnabled: record.voiceEnabled,
      voiceId: record.voiceId,
      speechRate: record.speechRate,
      pitch: record.pitch,
      desktopPetEnabled: record.desktopPetEnabled,
      proactiveChatEnabled: record.proactiveChatEnabled,
      proactiveChatFrequency: record.proactiveChatFrequency,
      screenPerceptionEnabled: record.screenPerceptionEnabled,
      screenPerceptionInterval: record.screenPerceptionInterval,
      personaVersion: record.personaVersion,
      persisted: true,
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  /** 对外接口用：校验权限后返回人格配置 */
  async get(userId: string, agentId: string): Promise<ResolvedPersona> {
    await this.assertPlatformAssistant(agentId, userId);
    return this.resolveForAgent(agentId);
  }

  // ===========================================================================
  // 写入
  // ===========================================================================

  /**
   * 保存人格配置（upsert）。
   *
   * personaVersion 每次保存自增 —— 这样「改了人格 → 效果变差 → 回滚」有据可查，
   * 审计日志里也能对上是哪一版人格产生了什么回答。
   */
  async upsert(
    userId: string,
    agentId: string,
    dto: UpdatePersonaDto,
  ): Promise<ResolvedPersona> {
    await this.assertPlatformAssistant(agentId, userId);

    const data = { ...dto };
    // 感知间隔兜底：DTO 已限制 >= 30，这里再挡一次，防止绕过 DTO 的调用路径
    if (
      typeof data.screenPerceptionInterval === 'number' &&
      data.screenPerceptionInterval < MIN_PERCEPTION_INTERVAL
    ) {
      data.screenPerceptionInterval = MIN_PERCEPTION_INTERVAL;
    }
    // 关闭主动搭话时，频率档位没有意义，统一归零，避免前端读到矛盾配置
    if (data.proactiveChatEnabled === false && !data.proactiveChatFrequency) {
      data.proactiveChatFrequency = 'off';
    }

    const existing = await this.prisma.agentPersona.findUnique({
      where: { agentId },
      select: { personaVersion: true },
    });

    const saved = await this.prisma.agentPersona.upsert({
      where: { agentId },
      create: {
        agentId,
        name: dto.name ?? DEFAULT_PERSONA_NAME,
        tags: dto.tags ?? [...DEFAULT_PERSONA_TAGS],
        systemPrompt: dto.systemPrompt ?? DEFAULT_PERSONA_PROMPT,
        avatar: dto.avatar,
        voiceEnabled: dto.voiceEnabled ?? true,
        voiceId: dto.voiceId ?? 'zh-CN-XiaoyiNeural',
        speechRate: dto.speechRate ?? 1.0,
        pitch: dto.pitch ?? 1.0,
        desktopPetEnabled: dto.desktopPetEnabled ?? false,
        proactiveChatEnabled: dto.proactiveChatEnabled ?? false,
        proactiveChatFrequency: dto.proactiveChatFrequency ?? 'low',
        screenPerceptionEnabled: dto.screenPerceptionEnabled ?? false,
        screenPerceptionInterval:
          dto.screenPerceptionInterval ?? MIN_PERCEPTION_INTERVAL * 2,
        personaVersion: 1,
      },
      update: {
        ...data,
        personaVersion: (existing?.personaVersion ?? 0) + 1,
      },
    });

    this.logger.log(
      `人格配置已更新：agent=${agentId} name="${saved.name}" v${saved.personaVersion} by=${userId}`,
    );
    return this.resolveForAgent(agentId);
  }

  /** 恢复默认人格（删除记录，回落到内存默认值） */
  async reset(userId: string, agentId: string): Promise<ResolvedPersona> {
    await this.assertPlatformAssistant(agentId, userId);
    await this.prisma.agentPersona
      .delete({ where: { agentId } })
      .catch(() => undefined); // 本来就没有记录 → 幂等
    this.logger.log(`人格配置已重置为默认：agent=${agentId} by=${userId}`);
    return this.defaultPersona();
  }
}
