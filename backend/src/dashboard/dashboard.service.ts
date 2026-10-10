import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface TimeRange {
  start: Date;
  end: Date;
  days: number;
}

function getTimeRange(days: number): TimeRange {
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - days);
  start.setHours(0, 0, 0, 0);
  return { start, end, days };
}

function getDateLabel(date: Date): string {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 获取用户有权限访问的 Workspace ID 列表
   * 用于所有统计接口的权限过滤
   */
  private async getUserWorkspaceIds(userId: string): Promise<string[]> {
    const workspaces = await this.prisma.workspace.findMany({
      where: {
        OR: [
          { ownerId: userId },
          { members: { some: { userId } } },
        ],
      },
      select: { id: true },
    });
    return workspaces.map((w) => w.id);
  }

  // ============================================================
  // 1. 核心指标卡片 - GET /dashboard/overview
  // ============================================================
  async getOverview(userId: string) {
    const workspaceIds = await this.getUserWorkspaceIds(userId);
    const range = getTimeRange(7);

    // 工作流总数 & 已发布数
    const [workflowTotal, workflowPublished] = await Promise.all([
      this.prisma.workflow.count({
        where: { workspaceId: { in: workspaceIds } },
      }),
      this.prisma.workflow.count({
        where: { workspaceId: { in: workspaceIds }, status: 'PUBLISHED' },
      }),
    ]);

    // 近 N 天的 WorkflowRun 统计
    const runs = await this.prisma.workflowRun.findMany({
      where: {
        workflow: { workspaceId: { in: workspaceIds } },
        createdAt: { gte: range.start, lte: range.end },
      },
      select: { status: true, startedAt: true, completedAt: true, input: true },
    });

    const totalRuns = runs.length;
    const completedRuns = runs.filter((r) => r.status === 'COMPLETED').length;
    const failedRuns = runs.filter((r) => r.status === 'FAILED').length;
    const queuedRuns = runs.filter((r) => r.status === 'QUEUED').length;
    const runningRuns = runs.filter((r) => r.status === 'RUNNING').length;
    const successRate = totalRuns > 0 ? (completedRuns / totalRuns) * 100 : 0;

    // 计算平均执行时长（毫秒）
    const durations = runs
      .filter((r) => r.startedAt && r.completedAt)
      .map((r) => r.completedAt!.getTime() - r.startedAt!.getTime());
    const avgDuration = durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : 0;

    // 知识库统计
    const kbTotal = await this.prisma.knowledgeBase.count({
      where: {
        OR: [
          { ownerId: userId },
          { workspaces: { some: { workspaceId: { in: workspaceIds } } } },
        ],
      },
    });

    // 文档统计
    const docStats = await this.prisma.document.aggregate({
      _count: { id: true },
      where: {
        knowledgeBase: {
          OR: [
            { ownerId: userId },
            { workspaces: { some: { workspaceId: { in: workspaceIds } } } },
          ],
        },
      },
    });

    // Agent 统计
    const agentTotal = await this.prisma.agent.count({
      where: {
        OR: [
          { createdBy: userId },
          { workspaceId: { in: workspaceIds } },
        ],
      },
    });

    // Skill & MCP 统计
    const [skillTotal, mcpTotal] = await Promise.all([
      this.prisma.skill.count({ where: { ownerId: userId } }),
      this.prisma.mcpServer.count({ where: { ownerId: userId } }),
    ]);

    // 注：Token 消耗暂未独立记录，后续可在 WorkflowRun/AgentRun 中补充 tokenUsage 字段
    const tokenUsage = 0;

    return {
      periodDays: range.days,
      workflows: {
        total: workflowTotal,
        published: workflowPublished,
        runCount: totalRuns,
        runCompleted: completedRuns,
        runFailed: failedRuns,
        runQueued: queuedRuns,
        runRunning: runningRuns,
        successRate: Number(successRate.toFixed(1)),
        avgDurationMs: avgDuration,
      },
      knowledgeBases: {
        total: kbTotal,
        documents: docStats._count.id,
      },
      agents: { total: agentTotal },
      skills: { total: skillTotal },
      mcpServers: { total: mcpTotal },
      tokenUsage,
    };
  }

  // ============================================================
  // 2. 工作流执行趋势 - GET /dashboard/workflows/trend
  // ============================================================
  async getWorkflowTrend(userId: string, days = 7) {
    const workspaceIds = await this.getUserWorkspaceIds(userId);
    const range = getTimeRange(days);

    // 按日期分组统计
    const runs = await this.prisma.workflowRun.findMany({
      where: {
        workflow: { workspaceId: { in: workspaceIds } },
        createdAt: { gte: range.start, lte: range.end },
      },
      select: { status: true, createdAt: true },
    });

    // 生成日期序列
    const dateMap = new Map<string, { date: string; total: number; success: number; failed: number }>();
    const cursor = new Date(range.start);
    while (cursor <= range.end) {
      const label = getDateLabel(cursor);
      dateMap.set(label, { date: label, total: 0, success: 0, failed: 0 });
      cursor.setDate(cursor.getDate() + 1);
    }

    for (const run of runs) {
      const label = getDateLabel(run.createdAt);
      const dayData = dateMap.get(label);
      if (!dayData) continue;
      dayData.total++;
      if (run.status === 'COMPLETED') dayData.success++;
      if (run.status === 'FAILED') dayData.failed++;
    }

    return Array.from(dateMap.values());
  }

  // ============================================================
  // 3. 工作流运行状态分布 - GET /dashboard/workflows/status
  // ============================================================
  async getWorkflowStatusDistribution(userId: string, days = 7) {
    const workspaceIds = await this.getUserWorkspaceIds(userId);
    const range = getTimeRange(days);

    const result = await this.prisma.workflowRun.groupBy({
      by: ['status'],
      where: {
        workflow: { workspaceId: { in: workspaceIds } },
        createdAt: { gte: range.start, lte: range.end },
      },
      _count: { status: true },
    });

    // 构建标准状态映射
    const statusMap: Record<string, number> = {
      COMPLETED: 0,
      FAILED: 0,
      RUNNING: 0,
      QUEUED: 0,
    };

    for (const item of result) {
      if (item.status in statusMap) {
        statusMap[item.status] = item._count.status;
      }
    }

    return statusMap;
  }

  // ============================================================
  // 4. 节点性能排行 - GET /dashboard/nodes/performance
  // ============================================================
  async getNodePerformance(userId: string, limit = 10) {
    const workspaceIds = await this.getUserWorkspaceIds(userId);
    const range = getTimeRange(30);

    const nodeRuns = await this.prisma.workflowNodeRun.findMany({
      where: {
        run: {
          workflow: { workspaceId: { in: workspaceIds } },
          createdAt: { gte: range.start, lte: range.end },
        },
        durationMs: { not: null },
      },
      select: { nodeType: true, durationMs: true, status: true },
    });

    // 按 nodeType 分组计算平均耗时
    const typeMap = new Map<string, { total: number; count: number; failed: number }>();
    for (const nr of nodeRuns) {
      const key = nr.nodeType;
      if (!typeMap.has(key)) {
        typeMap.set(key, { total: 0, count: 0, failed: 0 });
      }
      const entry = typeMap.get(key)!;
      entry.total += nr.durationMs!;
      entry.count++;
      if (nr.status === 'FAILED') entry.failed++;
    }

    const performance = Array.from(typeMap.entries())
      .map(([nodeType, data]) => ({
        nodeType,
        avgDurationMs: Math.round(data.total / data.count),
        count: data.count,
        failedCount: data.failed,
      }))
      .sort((a, b) => b.avgDurationMs - a.avgDurationMs)
      .slice(0, limit);

    return performance;
  }

  // ============================================================
  // 5. 知识库文档处理状态 - GET /dashboard/knowledge-bases/status
  // ============================================================
  async getKnowledgeStatus(userId: string) {
    const workspaceIds = await this.getUserWorkspaceIds(userId);

    const docs = await this.prisma.document.findMany({
      where: {
        knowledgeBase: {
          OR: [
            { ownerId: userId },
            { workspaces: { some: { workspaceId: { in: workspaceIds } } } },
          ],
        },
      },
      select: { status: true },
    });

    const statusMap: Record<string, number> = {
      UPLOADED: 0,
      PROCESSING: 0,
      COMPLETED: 0,
      FAILED: 0,
    };

    for (const doc of docs) {
      if (doc.status in statusMap) {
        statusMap[doc.status]++;
      }
    }

    const total = docs.length;
    const completed = statusMap.COMPLETED;
    const processing = statusMap.PROCESSING;
    const failed = statusMap.FAILED;

    return {
      total,
      completed,
      processing,
      failed,
      uploaded: statusMap.UPLOADED,
      completionRate: total > 0 ? Number(((completed / total) * 100).toFixed(1)) : 0,
    };
  }

  // ============================================================
  // 6. 最近运行记录 - GET /dashboard/recent-activities
  // ============================================================
  async getRecentActivities(userId: string, limit = 10) {
    const workspaceIds = await this.getUserWorkspaceIds(userId);

    const recentRuns = await this.prisma.workflowRun.findMany({
      where: {
        workflow: { workspaceId: { in: workspaceIds } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { workflow: { select: { id: true, name: true } } },
    });

    const recentDocs = await this.prisma.document.findMany({
      where: {
        knowledgeBase: {
          OR: [
            { ownerId: userId },
            { workspaces: { some: { workspaceId: { in: workspaceIds } } } },
          ],
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      include: {
        knowledgeBase: { select: { id: true, name: true } },
      },
    });

    return {
      workflowRuns: recentRuns.map((r) => ({
        id: r.id,
        workflowName: r.workflow.name,
        workflowId: r.workflow.id,
        status: r.status,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        createdAt: r.createdAt,
        errorMessage: r.errorMessage,
      })),
      documents: recentDocs.map((d) => ({
        id: d.id,
        fileName: d.fileName,
        knowledgeBaseName: d.knowledgeBase.name,
        status: d.status,
        errorMessage: d.errorMessage,
        updatedAt: d.updatedAt,
      })),
    };
  }

  // ============================================================
  // 7. BullMQ 队列状态 - GET /dashboard/queues/overview
  // ============================================================
  async getQueueOverview(userId: string) {
    const workspaceIds = await this.getUserWorkspaceIds(userId);
    const range = getTimeRange(24); // 最近 24 小时

    const workflowRunWhere = {
      workflow: { workspaceId: { in: workspaceIds } },
      createdAt: { gte: range.start },
    };

    const [queuedCount, completedCount, failedCount, runningCount] = await Promise.all([
      this.prisma.workflowRun.count({
        where: { ...workflowRunWhere, status: 'QUEUED' },
      }),
      this.prisma.workflowRun.count({
        where: { ...workflowRunWhere, status: 'COMPLETED' },
      }),
      this.prisma.workflowRun.count({
        where: { ...workflowRunWhere, status: 'FAILED' },
      }),
      this.prisma.workflowRun.count({
        where: { ...workflowRunWhere, status: 'RUNNING' },
      }),
    ]);

    // 查找最老的等待中任务
    const oldestWaiting = queuedCount > 0
      ? await this.prisma.workflowRun.findFirst({
          where: { workflow: { workspaceId: { in: workspaceIds } }, status: 'QUEUED' },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }).then((r) => r?.createdAt ?? null)
      : null;

    return {
      waiting: queuedCount,
      active: runningCount,
      completed: completedCount,
      failed: failedCount,
      delayed: 0,
      oldestWaiting,
    };
  }
}
