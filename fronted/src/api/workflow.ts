import { request } from "@/utils/request";
import { useUserStore } from "@/stores/user";
import type {
  CreateWorkflowRequest,
  UpdateWorkflowRequest,
  WorkflowDefinition,
  Workflow,
} from "@/types/workflow";

export interface RunWorkflowRequest {
  workflow: WorkflowDefinition;
  input: unknown;
}

export interface WorkflowRunResult {
  input: unknown;
  data: Record<string, unknown>;
}

/** BullMQ 异步运行 —— 入队后立即返回，前端轮询 getRun 查结果 */
export interface WorkflowRun {
  id: string;
  workflowId: string;
  input: unknown | null;
  output: unknown | null;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  /** getRun 会带 workflow 信息，listRuns / enqueueRun 返回不带 */
  workflow?: { id: string; name: string };
}

export type WorkflowStreamEvent =
  | { type: "node:start"; nodeId: string; nodeType: string; label?: string }
  | { type: "token"; nodeId: string; content: string }
  | {
      type: "node:complete";
      nodeId: string;
      nodeType: string;
      output: unknown;
      /** Condition 节点执行的分支（'true' | 'false'），普通节点为空 */
      branch?: string;
      /** Condition 节点的详细判断元数据（各条件的实际值/运算符/结果） */
      metadata?: Record<string, unknown>;
    }
  | { type: "complete"; data: Record<string, unknown> }
  | { type: "error"; message: string };

export const createWorkflow = (
  workspaceId: string,
  data: CreateWorkflowRequest,
): Promise<Workflow> => {
  return request.post(`/workspaces/${workspaceId}/workflows`, data);
};

export const getWorkflows = (workspaceId: string): Promise<Workflow[]> => {
  return request.get(`/workspaces/${workspaceId}/workflows`);
};

export const getWorkflow = (workflowId: string): Promise<Workflow> => {
  return request.get(`/workflows/${workflowId}`);
};

export const updateWorkflow = (
  workflowId: string,
  data: UpdateWorkflowRequest,
): Promise<Workflow> => {
  return request.put(`/workflows/${workflowId}`, data);
};

export const runWorkflow = (
  data: RunWorkflowRequest,
): Promise<WorkflowRunResult> => {
  return request.post("/workflow/run", data);
};

export const runWorkflowStream = async (
  data: RunWorkflowRequest,
  onEvent: (event: WorkflowStreamEvent) => void,
) => {
  const userStore = useUserStore();
  const response = await fetch("/api/workflow/run/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(userStore.token
        ? { Authorization: `Bearer ${userStore.token}` }
        : {}),
    },
    body: JSON.stringify(data),
  });

  if (!response.ok || !response.body) {
    throw new Error(`工作流运行请求失败: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });

    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const eventText of events) {
      const dataLine = eventText
        .split("\n")
        .find((line) => line.startsWith("data: "));
      if (!dataLine) continue;

      const event = JSON.parse(dataLine.slice(6)) as WorkflowStreamEvent;
      onEvent(event);
      if (event.type === "error") {
        throw new Error(event.message);
      }
    }

    if (done) break;
  }
};

// ===========================================================================
// BullMQ 异步运行（生产模式：入队 → 轮询 → 取结果）
// ===========================================================================

/** 入队一次工作流运行 —— 立即返回 runId，后台 BullMQ 执行 */
export const enqueueRun = (
  workflowId: string,
  input: unknown,
): Promise<WorkflowRun> => {
  return request.post(`/workflows/${workflowId}/run`, { input });
};

/** 查询单次运行结果（前端轮询用） */
export const getRun = (runId: string): Promise<WorkflowRun> => {
  return request.get(`/workflow-runs/${runId}`);
};

/** 查询某工作流的运行历史 */
export const listRuns = (workflowId: string): Promise<WorkflowRun[]> => {
  return request.get(`/workflows/${workflowId}/runs`);
};
