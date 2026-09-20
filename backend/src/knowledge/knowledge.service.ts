import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateKnowledgeBaseDto } from './dto/create-knowledge-base.dto';
import { UpdateKnowledgeBaseDto } from './dto/update-knowledge-base.dto';

const kbSelection = {
  id: true,
  ownerId: true,
  name: true,
  description: true,
  embeddingModel: true,
  embeddingDimension: true,
  documentCount: true,
  chunkCount: true,
  createdAt: true,
  updatedAt: true,
  _count: {
    select: {
      documents: true,
      workspaces: true,
    },
  },
} as const;

@Injectable()
export class KnowledgeService {
  constructor(private readonly prisma: PrismaService) {}

  /** 创建知识库（当前用户作为 owner） */
  create(userId: string, dto: CreateKnowledgeBaseDto) {
    return this.prisma.knowledgeBase.create({
      data: {
        ownerId: userId,
        name: dto.name,
        description: dto.description,
        embeddingModel: dto.embeddingModel,
        embeddingDimension: dto.embeddingDimension,
      },
      select: kbSelection,
    });
  }

  /** 获取当前用户的全部知识库 */
  findAll(userId: string) {
    return this.prisma.knowledgeBase.findMany({
      where: { ownerId: userId },
      orderBy: { createdAt: 'desc' },
      select: kbSelection,
    });
  }

  /** 获取单个知识库（owner 校验） */
  async findOne(userId: string, id: string) {
    const kb = await this.prisma.knowledgeBase.findUnique({
      where: { id },
      select: kbSelection,
    });
    if (!kb) throw new NotFoundException('Knowledge base not found');
    this.assertOwner(userId, kb);
    return kb;
  }

  /** 更新知识库 */
  async update(userId: string, id: string, dto: UpdateKnowledgeBaseDto) {
    await this.assertOwnerExists(userId, id);
    return this.prisma.knowledgeBase.update({
      where: { id },
      data: dto,
      select: kbSelection,
    });
  }

  /** 删除知识库（级联删除 documents + chunks + 关联关系） */
  async remove(userId: string, id: string) {
    await this.assertOwnerExists(userId, id);
    return this.prisma.knowledgeBase.delete({
      where: { id },
      select: kbSelection,
    });
  }

  // ===========================================================================
  // Workspace ↔ KnowledgeBase 关联
  // ===========================================================================

  /** 关联知识库到工作空间 */
  async linkToWorkspace(
    userId: string,
    workspaceId: string,
    knowledgeBaseId: string,
  ) {
    // 校验：用户是 workspace 的 owner/member，且是 kb 的 owner
    await this.assertWorkspaceMember(userId, workspaceId);
    await this.assertOwnerExists(userId, knowledgeBaseId);

    // upsert 避免重复
    await this.prisma.workspaceKnowledgeBase.upsert({
      where: {
        workspaceId_knowledgeBaseId: {
          workspaceId,
          knowledgeBaseId,
        },
      },
      update: {},
      create: {
        workspaceId,
        knowledgeBaseId,
      },
    });
  }

  /** 从工作空间解绑知识库 */
  async unlinkFromWorkspace(
    userId: string,
    workspaceId: string,
    knowledgeBaseId: string,
  ) {
    await this.assertWorkspaceMember(userId, workspaceId);

    await this.prisma.workspaceKnowledgeBase.deleteMany({
      where: {
        workspaceId,
        knowledgeBaseId,
      },
    });
  }

  /** 获取某工作空间关联的全部知识库 */
  async findByWorkspace(userId: string, workspaceId: string) {
    await this.assertWorkspaceMember(userId, workspaceId);

    const links = await this.prisma.workspaceKnowledgeBase.findMany({
      where: { workspaceId },
      select: { knowledgeBaseId: true },
    });

    const ids = links.map((l) => l.knowledgeBaseId);
    if (ids.length === 0) return [];

    return this.prisma.knowledgeBase.findMany({
      where: { id: { in: ids } },
      orderBy: { createdAt: 'desc' },
      select: kbSelection,
    });
  }

  // ===========================================================================
  // 权限工具
  // ===========================================================================

  private assertOwner(userId: string, kb: { ownerId: string }) {
    if (kb.ownerId !== userId) {
      throw new ForbiddenException('You do not own this knowledge base');
    }
  }

  private async assertOwnerExists(userId: string, id: string) {
    const kb = await this.prisma.knowledgeBase.findUnique({
      where: { id },
      select: { ownerId: true },
    });
    if (!kb) throw new NotFoundException('Knowledge base not found');
    if (kb.ownerId !== userId) {
      throw new ForbiddenException('You do not own this knowledge base');
    }
  }

  private async assertWorkspaceMember(userId: string, workspaceId: string) {
    const ws = await this.prisma.workspace.findFirst({
      where: {
        id: workspaceId,
        OR: [{ ownerId: userId }, { members: { some: { userId } } }],
      },
      select: { id: true },
    });
    if (!ws) {
      throw new ForbiddenException('You do not have access to this workspace');
    }
  }
}
