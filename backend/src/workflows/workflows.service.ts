import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
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

const workflowRunSelection = {
  id: true,
  workflowId: true,
  input: true,
  output: true,
  status: true,
  errorMessage: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
} as const;

@Injectable()
export class WorkflowsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('workflow-execution')
    private readonly workflowQueue: Queue,
  ) {}

  // ===========================================================================
  // Workflow CRUD
  // ===========================================================================

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

  // ===========================================================================
  // WorkflowRun（BullMQ 异步执行）
  // ===========================================================================

  /** 入队一次工作流运行 —— 立即返回 runId，后台 BullMQ 执行 */
  async enqueueRun(userId: string, workflowId: string, input: unknown) {
    // 1. 权限校验
    const workflow = await this.prisma.workflow.findFirst({
      where: {
        id: workflowId,
        workspace: { members: { some: { userId } } },
      },
      select: { id: true },
    });
    if (!workflow) {
      throw new NotFoundException('Workflow not found');
    }

    // 2. 创建 WorkflowRun 记录（status=QUEUED）
    const run = await this.prisma.workflowRun.create({
      data: {
        workflowId,
        input: input as Prisma.InputJsonValue,
        status: 'QUEUED',
      },
      select: workflowRunSelection,
    });

    // 3. 入队 → WorkflowProcessor 执行
    await this.workflowQueue.add(
      'execute-workflow',
      {
        runId: run.id,
        workflowId,
        input,
      },
      {
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    );

    return run;
  }

  /** 查询单次运行结果 */
  async getRun(userId: string, runId: string) {
    const run = await this.prisma.workflowRun.findUnique({
      where: { id: runId },
      select: {
        ...workflowRunSelection,
        workflow: {
          select: {
            id: true,
            name: true,
            workspace: {
              select: {
                members: { select: { userId: true } },
                ownerId: true,
              },
            },
          },
        },
      },
    });

    if (!run) {
      throw new NotFoundException('WorkflowRun not found');
    }

    // 权限：workspace owner 或 member
    const { workflow } = run;
    const isOwner = workflow.workspace.ownerId === userId;
    const isMember = workflow.workspace.members.some((m) => m.userId === userId);
    if (!isOwner && !isMember) {
      throw new ForbiddenException('You do not have access to this workflow run');
    }

    // 返回时去掉内部嵌套的 members 数据
    const { workflow: _workflow, ...rest } = run;
    return {
      ...rest,
      workflow: { id: workflow.id, name: workflow.name },
    };
  }

  /** 查询某工作流的运行历史 */
  async listRuns(userId: string, workflowId: string) {
    // 权限校验
    const workflow = await this.prisma.workflow.findFirst({
      where: {
        id: workflowId,
        workspace: { members: { some: { userId } } },
      },
      select: { id: true },
    });
    if (!workflow) {
      throw new NotFoundException('Workflow not found');
    }

    return this.prisma.workflowRun.findMany({
      where: { workflowId },
      orderBy: { createdAt: 'desc' },
      select: workflowRunSelection,
      take: 50,
    });
  }

  // ===========================================================================
  // 权限工具
  // ===========================================================================

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
