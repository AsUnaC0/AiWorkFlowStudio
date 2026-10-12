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
    running: number;
    successRate: number;
    avgDurationMs: number;
    p95DurationMs: number;
    failedLast24h: number;
  };
  knowledgeBases: { total: number; documents: number };
  agents: { total: number };
  skills: { total: number };
  mcpServers: { total: number };
  tokenUsage: number;
  modelCalls: number;
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
  failRate: number;
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
  errorCode: string | null;
  durationMs: number | null;
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
// 新增：工作流运行记录（列表 / 详情） + 模型调用统计
// ===========================================================================

export interface WorkflowRunItem {
  id: string;
  workflowId: string;
  workflowName: string;
  status: string;
  errorMessage: string | null;
  errorCode: string | null;
  triggerType: string;
  durationMs: number | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  failedNode: string | null;
  failedNodeType: string | null;
  failedNodeError: string | null;
}

export interface WorkflowRunListResult {
  items: WorkflowRunItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface RunNode {
  id: string;
  nodeId: string;
  nodeType: string;
  label: string | null;
  status: string;
  input: unknown;
  output: unknown;
  errorMessage: string | null;
  errorCode: string | null;
  attemptsMade: number;
  durationMs: number | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface RunModelCall {
  id: string;
  provider: string;
  model: string;
  callType: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number | null;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  estimatedCost: number | null;
  createdAt: string;
}

export interface WorkflowRunDetail {
  id: string;
  workflowId: string;
  workflowName: string;
  status: string;
  errorMessage: string | null;
  errorCode: string | null;
  triggerType: string;
  durationMs: number | null;
  input: unknown;
  output: unknown;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  nodes: RunNode[];
  modelCalls: RunModelCall[];
}

export interface ModelUsageModel {
  model: string;
  provider: string;
  calls: number;
  successRate: number;
  failed: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  estimatedCost: number;
}

export interface ModelUsage {
  periodDays: number;
  total: {
    calls: number;
    successRate: number;
    failed: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    avgLatencyMs: number;
    estimatedCost: number;
  };
  models: ModelUsageModel[];
}

// ===========================================================================
// API 方法
// ===========================================================================

/** 核心指标卡片 —— 资源规模、运行量、成功率、真实 Token 消耗 */
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

/** 工作流运行记录列表（支持 status / errorCode / triggerType / days / 分页筛选） */
export const getWorkflowRuns = (params: {
  status?: string;
  errorCode?: string;
  triggerType?: string;
  days?: number;
  page?: number;
  pageSize?: number;
}) => request.get("/dashboard/workflow-runs", { params }) as Promise<WorkflowRunListResult>;

/** 工作流运行详情（4 类信息：概览 / 节点 / 日志 / 模型调用） */
export const getWorkflowRunDetail = (runId: string) =>
  request.get(`/dashboard/workflow-runs/${runId}`) as Promise<WorkflowRunDetail>;

/** AI 模型调用统计（Token / 延迟 / 费用 / 成功率） */
export const getModelUsage = (days = 7) =>
  request.get("/dashboard/model-usage", { params: { days } }) as Promise<ModelUsage>;
