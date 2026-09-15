import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateWorkflowDto } from './dto/create-workflow.dto';
import { UpdateWorkflowDto } from './dto/update-workflow.dto';

const workflowSelection = {
  id: true,
  workspaceId: true,
  name: true,
  description: true,
  status: true,
  currentVersionId: true,
  createdAt: true,
  updatedAt: true,
  currentVersion: {
    select: { id: true, version: true, definition: true, createdAt: true },
  },
} as const;

@Injectable()
export class WorkflowsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, workspaceId: string, dto: CreateWorkflowDto) {
    await this.assertWorkspaceMember(userId, workspaceId);

    return this.prisma.$transaction(async (transaction) => {
      const workflow = await transaction.workflow.create({
        data: {
          workspaceId,
          name: dto.name,
          description: dto.description,
          versions: {
            create: {
              version: 1,
              definition: dto.definition as Prisma.InputJsonValue,
            },
          },
        },
        select: { id: true, versions: { select: { id: true } } },
      });

      return transaction.workflow.update({
        where: { id: workflow.id },
        data: { currentVersionId: workflow.versions[0].id },
        select: workflowSelection,
      });
    });
  }

  async findOne(userId: string, id: string) {
    const workflow = await this.prisma.workflow.findFirst({
      where: { id, workspace: { members: { some: { userId } } } },
      select: workflowSelection,
    });

    if (!workflow) {
      throw new NotFoundException('Workflow not found');
    }

    return workflow;
  }

  async findAll(userId: string, workspaceId: string) {
    await this.assertWorkspaceMember(userId, workspaceId);

    return this.prisma.workflow.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
      select: workflowSelection,
    });
  }

  async update(userId: string, id: string, dto: UpdateWorkflowDto) {
    const workflow = await this.prisma.workflow.findFirst({
      where: { id, workspace: { members: { some: { userId } } } },
      select: { id: true, workspaceId: true },
    });

    if (!workflow) {
      throw new NotFoundException('Workflow not found');
    }

    const latestVersion = await this.prisma.workflowVersion.findFirst({
      where: { workflowId: id },
      orderBy: { version: 'desc' },
      select: { version: true },
    });

    return this.prisma.$transaction(async (transaction) => {
      const version = await transaction.workflowVersion.create({
        data: {
          workflowId: id,
          version: (latestVersion?.version ?? 0) + 1,
          definition: dto.definition as Prisma.InputJsonValue,
        },
      });

      return transaction.workflow.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
          currentVersionId: version.id,
        },
        select: workflowSelection,
      });
    });
  }

  private async assertWorkspaceMember(userId: string, workspaceId: string) {
    const workspace = await this.prisma.workspace.findFirst({
      where: {
        id: workspaceId,
        OR: [{ ownerId: userId }, { members: { some: { userId } } }],
      },
      select: { id: true },
    });

    if (!workspace) {
      throw new ForbiddenException('You do not have access to this workspace');
    }
  }
}
