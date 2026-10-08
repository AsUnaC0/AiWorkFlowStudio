import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSkillDto } from './dto/create-skill.dto';
import { UpdateSkillDto } from './dto/update-skill.dto';

const skillSelection = {
  id: true,
  ownerId: true,
  name: true,
  description: true,
  type: true,
  instructions: true,
  inputSchema: true,
  outputFormat: true,
  workflowId: true,
  mcpServerId: true,
  mcpToolName: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** skillSelection 查询结果的强类型（`never[] | PrismaPromise` 联合类型会把调用方的数组元素推断成 never） */
type SkillSelection = Prisma.SkillGetPayload<{ select: typeof skillSelection }>;

@Injectable()
export class SkillService {
  constructor(private readonly prisma: PrismaService) {}

  /** 创建 Skill（当前用户作为 owner） */
  create(userId: string, dto: CreateSkillDto) {
    return this.prisma.skill.create({
      data: {
        ownerId: userId,
        name: dto.name,
        description: dto.description,
        type: dto.type ?? 'PROMPT',
        instructions: dto.instructions,
        inputSchema: dto.inputSchema as any,
        outputFormat: dto.outputFormat ?? 'Markdown',
        workflowId: dto.workflowId,
        mcpServerId: dto.mcpServerId,
        mcpToolName: dto.mcpToolName,
      },
      select: skillSelection,
    });
  }

  /** 获取当前用户的全部 Skills */
  findAll(userId: string) {
    return this.prisma.skill.findMany({
      where: { ownerId: userId },
      orderBy: { createdAt: 'desc' },
      select: skillSelection,
    });
  }

  /**
   * 按 ID 列表批量获取 Skills（工作流执行时用，无需 owner 校验）。
   * 工作流创建者已在编辑时确认拥有这些 Skills 的权限。
   */
  async findByIds(ids: string[]): Promise<SkillSelection[]> {
    if (ids.length === 0) return [];
    return this.prisma.skill.findMany({
      where: { id: { in: ids } },
      select: skillSelection,
    });
  }

  /** 获取单个 Skill（owner 校验） */
  async findOne(userId: string, id: string) {
    const skill = await this.prisma.skill.findUnique({
      where: { id },
      select: skillSelection,
    });
    if (!skill) throw new NotFoundException('Skill not found');
    this.assertOwner(userId, skill);
    return skill;
  }

  /** 更新 Skill */
  async update(userId: string, id: string, dto: UpdateSkillDto) {
    await this.assertOwnerExists(userId, id);
    const data: Record<string, unknown> = { ...dto };
    if (dto.inputSchema !== undefined) data.inputSchema = dto.inputSchema as any;
    return this.prisma.skill.update({
      where: { id },
      data,
      select: skillSelection,
    });
  }

  /** 删除 Skill */
  async remove(userId: string, id: string) {
    await this.assertOwnerExists(userId, id);
    return this.prisma.skill.delete({
      where: { id },
      select: skillSelection,
    });
  }

  // ===========================================================================
  // 权限工具
  // ===========================================================================

  private assertOwner(userId: string, skill: { ownerId: string }) {
    if (skill.ownerId !== userId) {
      throw new ForbiddenException('You do not own this skill');
    }
  }

  private async assertOwnerExists(userId: string, id: string) {
    const skill = await this.prisma.skill.findUnique({
      where: { id },
      select: { ownerId: true },
    });
    if (!skill) throw new NotFoundException('Skill not found');
    if (skill.ownerId !== userId) {
      throw new ForbiddenException('You do not own this skill');
    }
  }
}
