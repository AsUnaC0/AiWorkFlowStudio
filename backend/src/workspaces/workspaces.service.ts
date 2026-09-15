import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';

const workspaceSelection = {
  id: true,
  name: true,
  ownerId: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { members: true, workflows: true } },
} as const;

@Injectable()
export class WorkspacesService {
  constructor(private readonly prisma: PrismaService) {}

  create(userId: string, dto: CreateWorkspaceDto) {
    return this.prisma.workspace.create({
      data: {
        name: dto.name,
        ownerId: userId,
        members: {
          create: { userId },
        },
      },
      select: workspaceSelection,
    });
  }

  findAll(userId: string) {
    return this.prisma.workspace.findMany({
      where: {
        OR: [{ ownerId: userId }, { members: { some: { userId } } }],
      },
      orderBy: { createdAt: 'desc' },
      select: workspaceSelection,
    });
  }

  async findOne(userId: string, id: string) {
    const workspace = await this.prisma.workspace.findFirst({
      where: {
        id,
        OR: [{ ownerId: userId }, { members: { some: { userId } } }],
      },
      select: workspaceSelection,
    });

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    return workspace;
  }

  async update(userId: string, id: string, dto: UpdateWorkspaceDto) {
    await this.assertOwner(userId, id);

    return this.prisma.workspace.update({
      where: { id },
      data: { name: dto.name },
      select: workspaceSelection,
    });
  }

  async remove(userId: string, id: string) {
    await this.assertOwner(userId, id);

    return this.prisma.workspace.delete({
      where: { id },
      select: workspaceSelection,
    });
  }

  private async assertOwner(userId: string, id: string) {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id },
      select: { ownerId: true },
    });

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    if (workspace.ownerId !== userId) {
      throw new ForbiddenException('Only the workspace owner can modify it');
    }
  }
}
