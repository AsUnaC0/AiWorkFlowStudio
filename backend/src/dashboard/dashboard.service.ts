import { Injectable, NotFoundException } from '@nestjs/common';
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

// ===========================================================================
// 敏感信息脱敏：节点输入/输出、模型请求里可能包含 API Key / Token
// ===========================================================================
function isSecretString(s: string): boolean {
  return (
    /(sk-|pk-|akid|secret|api[_-]?key|access[_-]?key|token|password|bearer|passwd)/i.test(
      s,
    ) && s.length > 12
  );
}

function maskSecret(s: string): string {
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

function desensitize(value: unknown): unknown {
  if (typeof value === 'string') {
    return isSecretString(value) ? maskSecret(value) : value;
  }
  if (Array.isArray(value)) return value.map(desensitize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const keyLooksSecret = /(key|token|secret|password|ak|sk|pk|passwd)/i.test(k);
      out[k] =
        keyLooksSecret && typeof v === 'string' ? maskSecret(v) : desensitize(v);
    }
    return out;
  }
  return value;
}

function parseJsonInput(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
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
        OR: [{ ownerId: userId }, { members: { some: { userId } } }],
      },
      select: { id: true },
    });
    return workspaces.map((w) => w.id);
  }

  // ============================================================
  // 1. 核心指标卡片 - GET /dashboard/overview
  // ============================================================
  async getOverview(userId: string, days = 7) {
    const workspaceIds = await this.getUserWorkspaceIds(userId);
    const range = getTimeRange(days);

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
      select: {
        status: true,
        startedAt: true,
        completedAt: true,
        durationMs: true,
      },
    });

    const totalRuns = runs.length;
    const completedRuns = runs.filter((r) => r.status === 'COMPLETED').length;
    const failedRuns = runs.filter((r) => r.status === 'FAILED').length;
    const queuedRuns = runs.filter((r) => r.status === 'QUEUED').length;
    const runningRuns = runs.filter((r) => r.status === 'RUNNING').length;
    const successRate = totalRuns > 0 ? (completedRuns / totalRuns) * 100 : 0;

    // 计算平均 / P95 执行时长（毫秒）—— 优先用已落库的 durationMs
    const durations = runs
      .filter((r) => r.durationMs != null)
      .map((r) => r.durationMs!)
      .concat(
        runs
          .filter((r) => !r.durationMs && r.startedAt && r.completedAt)
          .map((r) => r.completedAt!.getTime() - r.startedAt!.getTime()),
      );
    const avgDuration = durations.length
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : 0;
    const p95Duration = durations.length
      ? durations.slice().sort((a, b) => a - b)[Math.floor(durations.length * 0.95)]
      : 0;

    // 最近 24 小时失败数
    const failedLast24h = await this.prisma.workflowRun.count({
      where: {
        workflow: { workspaceId: { in: workspaceIds } },
        status: 'FAILED',
        createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) },
      },
    });

    // 真实 Token 消耗 & 模型调用次数（来自 ModelCallLog）
    const [tokenAgg, modelCalls] = await Promise.all([
      this.prisma.modelCallLog.aggregate({
        _sum: { totalTokens: true },
        where: {
          workspaceId: { in: workspaceIds },
          createdAt: { gte: range.start, lte: range.end },
        },
      }),
      this.prisma.modelCallLog.count({
        where: {
          workspaceId: { in: workspaceIds },
          createdAt: { gte: range.start, lte: range.end },
        },
      }),
    ]);

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
        running: runningRuns,
        successRate: Number(successRate.toFixed(1)),
        avgDurationMs: avgDuration,
        p95DurationMs: p95Duration,
        failedLast24h,
      },
      knowledgeBases: {
        total: kbTotal,
        documents: docStats._count.id,
      },
      agents: { total: agentTotal },
      skills: { total: skillTotal },
      mcpServers: { total: mcpTotal },
      tokenUsage: tokenAgg._sum.totalTokens ?? 0,
      modelCalls: modelCalls,
    };
  }

  // ============================================================
  // 2. 工作流执行趋势 - GET /dashboard/workflows/trend
  // ============================================================
  async getWorkflowTrend(userId: string, days = 7) {
    const workspaceIds = await this.getUserWorkspaceIds(userId);
    const range = getTimeRange(days);

    const runs = await this.prisma.workflowRun.findMany({
      where: {
        workflow: { workspaceId: { in: workspaceIds } },
        createdAt: { gte: range.start, lte: range.end },
      },
      select: { status: true, createdAt: true },
    });

    const dateMap = new Map<
      string,
      { date: string; total: number; success: number; failed: number }
    >();
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

    const typeMap = new Map<
      string,
      { total: number; count: number; failed: number }
    >();
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
        failRate: Number(((data.failed / data.count) * 100).toFixed(1)),
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
        errorCode: r.errorCode,
        durationMs: r.durationMs,
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

    const [queuedCount, completedCount, failedCount, runningCount] =
      await Promise.all([
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

    const oldestWaiting =
      queuedCount > 0
        ? await this.prisma.workflowRun
            .findFirst({
              where: {
                workflow: { workspaceId: { in: workspaceIds } },
                status: 'QUEUED',
              },
              orderBy: { createdAt: 'asc' },
              select: { createdAt: true },
            })
            .then((r) => r?.createdAt ?? null)
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

  // ============================================================
  // 8. 工作流运行记录列表（筛选 + 分页）- GET /dashboard/workflow-runs
  // ============================================================
  async getWorkflowRuns(
    userId: string,
    params: {
      status?: string;
      errorCode?: string;
      triggerType?: string;
      days?: number;
      page?: number;
      pageSize?: number;
    } = {},
  ) {
    const workspaceIds = await this.getUserWorkspaceIds(userId);
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 10));

    const where: Record<string, unknown> = {
      workflow: { workspaceId: { in: workspaceIds } },
    };
    if (params.status) where.status = params.status;
    if (params.errorCode) where.errorCode = params.errorCode;
    if (params.triggerType) where.triggerType = params.triggerType;
    if (params.days) {
      where.createdAt = { gte: getTimeRange(params.days).start };
    }

    const [total, runs] = await Promise.all([
      this.prisma.workflowRun.count({ where }),
      this.prisma.workflowRun.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          workflowId: true,
          status: true,
          errorMessage: true,
          errorCode: true,
          triggerType: true,
          durationMs: true,
          startedAt: true,
          completedAt: true,
          createdAt: true,
          workflow: { select: { name: true } },
        },
      }),
    ]);

    // 每个运行的失败节点（首个 FAILED 节点）
    const runIds = runs.map((r) => r.id);
    const failedNodes =
      runIds.length > 0
        ? await this.prisma.workflowNodeRun.findMany({
            where: { runId: { in: runIds }, status: 'FAILED' },
            select: {
              runId: true,
              label: true,
              nodeType: true,
              errorMessage: true,
              errorCode: true,
            },
            orderBy: { startedAt: 'asc' },
          })
        : [];
    const failedByRun = new Map<string, (typeof failedNodes)[number]>();
    for (const n of failedNodes) {
      if (!failedByRun.has(n.runId)) failedByRun.set(n.runId, n);
    }

    const items = runs.map((r) => {
      const fn = failedByRun.get(r.id);
      return {
        id: r.id,
        workflowId: r.workflowId,
        workflowName: r.workflow.name,
        status: r.status,
        errorMessage: r.errorMessage,
        errorCode: r.errorCode,
        triggerType: r.triggerType,
        durationMs: r.durationMs,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        createdAt: r.createdAt,
        failedNode: fn ? fn.label || fn.nodeType : null,
        failedNodeType: fn?.nodeType ?? null,
        failedNodeError: fn?.errorMessage ?? null,
      };
    });

    return { items, total, page, pageSize };
  }

  // ============================================================
  // 9. 工作流运行详情 - GET /dashboard/workflow-runs/:runId
  // ============================================================
  async getWorkflowRunDetail(userId: string, runId: string) {
    const workspaceIds = await this.getUserWorkspaceIds(userId);

    const run = await this.prisma.workflowRun.findFirst({
      where: {
        id: runId,
        workflow: { workspaceId: { in: workspaceIds } },
      },
      include: {
        workflow: { select: { id: true, name: true } },
        nodeRuns: { orderBy: { startedAt: 'asc' } },
        modelCalls: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (!run) {
      throw new NotFoundException('运行记录不存在或无权访问');
    }

    return {
      id: run.id,
      workflowId: run.workflow.id,
      workflowName: run.workflow.name,
      status: run.status,
      errorMessage: run.errorMessage,
      errorCode: run.errorCode,
      triggerType: run.triggerType,
      durationMs: run.durationMs,
      input: desensitize(parseJsonInput(run.input)),
      output: desensitize(parseJsonInput(run.output)),
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      createdAt: run.createdAt,
      nodes: run.nodeRuns.map((n) => ({
        id: n.id,
        nodeId: n.nodeId,
        nodeType: n.nodeType,
        label: n.label,
        status: n.status,
        input: desensitize(parseJsonInput(n.input)),
        output: desensitize(parseJsonInput(n.output)),
        errorMessage: n.errorMessage,
        errorCode: n.errorCode,
        attemptsMade: n.attemptsMade,
        durationMs: n.durationMs,
        startedAt: n.startedAt,
        endedAt: n.endedAt,
      })),
      modelCalls: run.modelCalls.map((m) => ({
        id: m.id,
        provider: m.provider,
        model: m.model,
        callType: m.callType,
        promptTokens: m.promptTokens,
        completionTokens: m.completionTokens,
        totalTokens: m.totalTokens,
        latencyMs: m.latencyMs,
        status: m.status,
        errorCode: m.errorCode,
        errorMessage: m.errorMessage,
        estimatedCost: m.estimatedCost,
        createdAt: m.createdAt,
      })),
    };
  }

  // ============================================================
  // 10. 模型调用统计 - GET /dashboard/model-usage
  // ============================================================
  async getModelUsage(userId: string, days = 7) {
    const workspaceIds = await this.getUserWorkspaceIds(userId);
    const range = getTimeRange(days);

    const logs = await this.prisma.modelCallLog.findMany({
      where: {
        workspaceId: { in: workspaceIds },
        createdAt: { gte: range.start, lte: range.end },
      },
      select: {
        model: true,
        provider: true,
        status: true,
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
        latencyMs: true,
        estimatedCost: true,
      },
    });

    const totalCalls = logs.length;
    const failed = logs.filter((l) => l.status !== 'SUCCESS').length;
    const totalPrompt = logs.reduce((a, l) => a + l.promptTokens, 0);
    const totalCompletion = logs.reduce((a, l) => a + l.completionTokens, 0);
    const totalTokens = logs.reduce((a, l) => a + l.totalTokens, 0);
    const latencies = logs
      .filter((l) => l.latencyMs != null)
      .map((l) => l.latencyMs!);
    const avgLatency = latencies.length
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : 0;
    const totalCost = logs.reduce((a, l) => a + (l.estimatedCost || 0), 0);

    // 按模型聚合
    const byModel = new Map<
      string,
      {
        model: string;
        provider: string;
        calls: number;
        success: number;
        failed: number;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        latencySum: number;
        latencyCount: number;
        cost: number;
      }
    >();
    for (const l of logs) {
      if (!byModel.has(l.model)) {
        byModel.set(l.model, {
          model: l.model,
          provider: l.provider,
          calls: 0,
          success: 0,
          failed: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          latencySum: 0,
          latencyCount: 0,
          cost: 0,
        });
      }
      const e = byModel.get(l.model)!;
      e.calls++;
      if (l.status === 'SUCCESS') e.success++;
      else e.failed++;
      e.promptTokens += l.promptTokens;
      e.completionTokens += l.completionTokens;
      e.totalTokens += l.totalTokens;
      if (l.latencyMs != null) {
        e.latencySum += l.latencyMs;
        e.latencyCount++;
      }
      e.cost += l.estimatedCost || 0;
    }

    const models = Array.from(byModel.values())
      .map((e) => ({
        model: e.model,
        provider: e.provider,
        calls: e.calls,
        successRate: e.calls
          ? Number(((e.success / e.calls) * 100).toFixed(1))
          : 0,
        failed: e.failed,
        promptTokens: e.promptTokens,
        completionTokens: e.completionTokens,
        totalTokens: e.totalTokens,
        avgLatencyMs: e.latencyCount
          ? Math.round(e.latencySum / e.latencyCount)
          : 0,
        estimatedCost: Number(e.cost.toFixed(4)),
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens);

    return {
      periodDays: range.days,
      total: {
        calls: totalCalls,
        successRate: totalCalls
          ? Number((((totalCalls - failed) / totalCalls) * 100).toFixed(1))
          : 0,
        failed,
        promptTokens: totalPrompt,
        completionTokens: totalCompletion,
        totalTokens,
        avgLatencyMs: avgLatency,
        estimatedCost: Number(totalCost.toFixed(4)),
      },
      models,
    };
  }
}
