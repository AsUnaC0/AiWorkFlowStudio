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

const workflowVersionSelection = {
  id: true,
  version: true,
  definition: true,
  createdAt: true,
} as const;

const workflowSelection = {
  id: true,
  workspaceId: true,
  name: true,
  description: true,
  status: true,
  currentVersionId: true,
  publishedVersionId: true,
  createdAt: true,
  updatedAt: true,
  currentVersion: { select: workflowVersionSelection },
  publishedVersion: { select: workflowVersionSelection },
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
  // Workflow 状态机：Publish / Archive
  // ===========================================================================

  /**
   * 发布当前草稿版本：
   *  - 把 currentVersionId 镜像成一个新的 WorkflowVersion（v+1，作为正式发布版本）
   *  - 把 publishedVersionId 指向这个新版本
   *  - 状态置为 PUBLISHED
   *  - 状态机：DRAFT 或 PUBLISHED 才能发布；ARCHIVED 不能直接发布（需先恢复成 DRAFT）
   *
   * 用一个独立 version 流水保证 publishedVersion 始终 >= 已发布版本，
   * 与 currentVersion 解耦 —— 后续草稿修改不影响 Agent 调用的稳定版本。
   */
  async publish(userId: string, id: string) {
    const workflow = await this.prisma.workflow.findFirst({
      where: { id, workspace: { members: { some: { userId } } } },
      select: {
        id: true,
        status: true,
        currentVersionId: true,
        publishedVersion: { select: { version: true } },
      },
    });

    if (!workflow) {
      throw new NotFoundException('Workflow not found');
    }
    if (workflow.status === 'ARCHIVED') {
      throw new ForbiddenException(
        '已归档的工作流不能直接发布，请先恢复为草稿状态',
      );
    }
    if (!workflow.currentVersionId) {
      throw new ForbiddenException('工作流没有草稿版本，无法发布');
    }

    // 拉取草稿版本的 definition（这是要"快照"成发布版本的内容）
    const draftVersion = await this.prisma.workflowVersion.findUnique({
      where: { id: workflow.currentVersionId },
      select: { definition: true },
    });
    if (!draftVersion) {
      throw new NotFoundException('草稿版本不存在');
    }

    // 查该 workflow 已有的最大 version → +1 保证不冲突
    // 不能只靠 publishedVersion?.version + 1，因为 create 时已经有 v1 了，
    // 第一次 publish 会算出 version=1 和已有的 currentVersion(v1) 撞 unique constraint
    const latestVersion = await this.prisma.workflowVersion.findFirst({
      where: { workflowId: id },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const nextPublishVersion = (latestVersion?.version ?? 0) + 1;

    return this.prisma.$transaction(async (transaction) => {
      // 1. 创建一个新的 WorkflowVersion 作为发布快照
      const publishedVersion = await transaction.workflowVersion.create({
        data: {
          workflowId: id,
          version: nextPublishVersion,
          definition: draftVersion.definition as Prisma.InputJsonValue,
        },
      });

      // 2. 把 publishedVersionId 指向它，status 置为 PUBLISHED
      //    同时让 currentVersionId 也指向它，保证列表 [编辑] 时基于最新发布版本继续编辑
      return transaction.workflow.update({
        where: { id },
        data: {
          status: 'PUBLISHED',
          publishedVersionId: publishedVersion.id,
          currentVersionId: publishedVersion.id,
        },
        select: workflowSelection,
      });
    });
  }

  /**
   * 归档工作流：
   *  - 状态置为 ARCHIVED，Agent 无法再调用
   *  - 保留 publishedVersionId 和 currentVersionId（历史追溯用）
   *  - 状态机：PUBLISHED 才能归档；DRAFT/ARCHIVED 不能直接归档
   */
  async archive(userId: string, id: string) {
    const workflow = await this.prisma.workflow.findFirst({
      where: { id, workspace: { members: { some: { userId } } } },
      select: { id: true, status: true },
    });

    if (!workflow) {
      throw new NotFoundException('Workflow not found');
    }
    if (workflow.status !== 'PUBLISHED') {
      throw new ForbiddenException('只有已发布的工作流才能归档');
    }

    return this.prisma.workflow.update({
      where: { id },
      data: { status: 'ARCHIVED' },
      select: workflowSelection,
    });
  }

  /**
   * 把已归档工作流恢复为草稿：
   *  - 状态从 ARCHIVED → DRAFT
   *  - 不影响 publishedVersionId（如需重新发布调用 publish）
   *  - 状态机：只有 ARCHIVED 才能恢复
   */
  async restore(userId: string, id: string) {
    const workflow = await this.prisma.workflow.findFirst({
      where: { id, workspace: { members: { some: { userId } } } },
      select: { id: true, status: true },
    });

    if (!workflow) {
      throw new NotFoundException('Workflow not found');
    }
    if (workflow.status !== 'ARCHIVED') {
      throw new ForbiddenException('只有已归档的工作流才能恢复为草稿');
    }

    return this.prisma.workflow.update({
      where: { id },
      data: { status: 'DRAFT' },
      select: workflowSelection,
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
    const isMember = workflow.workspace.members.some(
      (m) => m.userId === userId,
    );
    if (!isOwner && !isMember) {
      throw new ForbiddenException(
        'You do not have access to this workflow run',
      );
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

  /** 查询某次运行的节点级执行记录（按执行顺序） */
  async listNodeRuns(userId: string, runId: string) {
    const run = await this.prisma.workflowRun.findUnique({
      where: { id: runId },
      select: {
        id: true,
        workflowId: true,
        workflow: {
          select: {
            workspace: {
              select: { ownerId: true, members: { select: { userId: true } } },
            },
          },
        },
      },
    });

    if (!run) {
      throw new NotFoundException('WorkflowRun not found');
    }

    // 权限校验
    const isOwner = run.workflow.workspace.ownerId === userId;
    const isMember = run.workflow.workspace.members.some(
      (m) => m.userId === userId,
    );
    if (!isOwner && !isMember) {
      throw new ForbiddenException(
        'You do not have access to this workflow run',
      );
    }

    return this.prisma.workflowNodeRun.findMany({
      where: { runId },
      orderBy: { startedAt: 'asc' },
      select: {
        id: true,
        runId: true,
        nodeId: true,
        nodeType: true,
        label: true,
        status: true,
        input: true,
        output: true,
        branch: true,
        metadata: true,
        errorMessage: true,
        startedAt: true,
        endedAt: true,
        durationMs: true,
        createdAt: true,
      },
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
