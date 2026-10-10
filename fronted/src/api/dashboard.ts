import { request } from "@/utils/request";

// ===========================================================================
// 类型定义 —— 与后端 DashboardService 返回结构保持一致
// ===========================================================================

export interface DashboardOverview {
  periodDays: number;
  workflows: {
    total: number;
    published: number;
    runCount: number;
    runCompleted: number;
    runFailed: number;
    runQueued: number;
    runRunning: number;
    successRate: number;
    avgDurationMs: number;
  };
  knowledgeBases: { total: number; documents: number };
  agents: { total: number };
  skills: { total: number };
  mcpServers: { total: number };
  tokenUsage: number;
}

export interface WorkflowTrendItem {
  date: string;
  total: number;
  success: number;
  failed: number;
}

export type WorkflowStatusMap = Record<string, number>;

export interface NodePerformanceItem {
  nodeType: string;
  avgDurationMs: number;
  count: number;
  failedCount: number;
}

export interface KnowledgeStatus {
  total: number;
  completed: number;
  processing: number;
  failed: number;
  uploaded: number;
  completionRate: number;
}

export interface RecentWorkflowRun {
  id: string;
  workflowName: string;
  workflowId: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  errorMessage: string | null;
}

export interface RecentDocument {
  id: string;
  fileName: string;
  knowledgeBaseName: string;
  status: string;
  errorMessage: string | null;
  updatedAt: string;
}

export interface RecentActivities {
  workflowRuns: RecentWorkflowRun[];
  documents: RecentDocument[];
}

export interface QueueOverview {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  oldestWaiting: string | null;
}

// ===========================================================================
// API 方法
// ===========================================================================

/** 核心指标卡片 —— 资源规模、运行量、成功率、Token 消耗 */
export const getOverview = () => request.get("/dashboard/overview") as Promise<DashboardOverview>;

/** 工作流执行趋势（按天分组） */
export const getWorkflowTrend = (days = 7) =>
  request.get("/dashboard/workflows/trend", { params: { days } }) as Promise<WorkflowTrendItem[]>;

/** 工作流运行状态分布 —— { COMPLETED, FAILED, RUNNING, QUEUED } */
export const getWorkflowStatus = (days = 7) =>
  request.get("/dashboard/workflows/status", { params: { days } }) as Promise<WorkflowStatusMap>;

/** 节点类型平均耗时排行 */
export const getNodePerformance = (limit = 10) =>
  request.get("/dashboard/nodes/performance", { params: { limit } }) as Promise<NodePerformanceItem[]>;

/** 知识库文档处理状态 */
export const getKnowledgeStatus = () =>
  request.get("/dashboard/knowledge-bases/status") as Promise<KnowledgeStatus>;

/** 最近运行记录 + 文档处理活动 */
export const getRecentActivities = (limit = 10) =>
  request.get("/dashboard/recent-activities", { params: { limit } }) as Promise<RecentActivities>;

/** BullMQ 队列积压状态 */
export const getQueueOverview = () =>
  request.get("/dashboard/queues/overview") as Promise<QueueOverview>;
