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

export type WorkflowStreamEvent =
  | { type: "node:start"; nodeId: string; nodeType: string; label?: string }
  | { type: "token"; nodeId: string; content: string }
  | {
      type: "node:complete";
      nodeId: string;
      nodeType: string;
      output: unknown;
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
