import { request } from "@/utils/request";
import { useUserStore } from "@/stores/user";
import type { AgentStreamEvent } from "@/types/agent";

// ===========================================================================
// 资源查询（前端聊天页下拉用）
// ===========================================================================

export interface AgentResourceWorkflow {
  id: string;
  name: string;
  description: string | null;
  publishedVersion: { version: number } | null;
}

export interface AgentResourceKnowledgeBase {
  id: string;
  name: string;
  description: string | null;
  documentCount: number;
  chunkCount: number;
}

export const getAgentResources = async (): Promise<{
  workflows: AgentResourceWorkflow[];
  knowledgeBases: AgentResourceKnowledgeBase[];
}> => {
  return request.get(`/agent/resources`);
};

// ===========================================================================
// Agent 无状态聊天（SSE 流式）
// ===========================================================================

export interface AgentChatRequest {
  input: string;
  history?: Array<{ role: string; content: string }>;
  model?: string;
  workflowIds?: string[];
  knowledgeBaseIds?: string[];
  systemPrompt?: string;
  temperature?: number;
  maxToolIterations?: number;
}

/**
 * 运行 Agent —— SSE 流式事件推送。
 * 工具（Workflow / KnowledgeBase）由请求体动态传入，不再依赖持久化 Agent 记录。
 * 返回一个 Promise，resolve 在流结束时；事件通过 onEvent 回调推送。
 *
 * 事件类型：thinking → tool_call → tool_result → message → error
 */
export const runAgentStream = async (
  data: AgentChatRequest,
  onEvent: (event: AgentStreamEvent) => void,
): Promise<void> => {
  const userStore = useUserStore();
  const response = await fetch(`/api/agent/chat/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(userStore.token ? { Authorization: `Bearer ${userStore.token}` } : {}),
    },
    body: JSON.stringify(data),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Agent 请求失败: ${response.status}`);
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

      const event = JSON.parse(dataLine.slice(6)) as AgentStreamEvent;
      onEvent(event);
      if (event.type === "error") {
        throw new Error(event.message);
      }
    }

    if (done) break;
  }
};
