import { request } from "@/utils/request";
import { useUserStore } from "@/stores/user";
import type {
  Agent,
  CreateAgentRequest,
  UpdateAgentRequest,
  ChatSession,
  ChatSessionListItem,
  ChatSessionDetail,
  ChatMessage,
  AgentStreamEvent,
} from "@/types/agent";

// ===========================================================================
// Agent CRUD
// ===========================================================================

/** 列出当前用户可见的所有 Agent */
export const listAgents = (): Promise<Agent[]> => {
  return request.get(`/agents`);
};

/** 创建新 Agent */
export const createAgent = (data: CreateAgentRequest): Promise<Agent> => {
  return request.post(`/agents`, data);
};

/** 获取 Agent 详情 */
export const getAgent = (agentId: string): Promise<Agent> => {
  return request.get(`/agents/${agentId}`);
};

/** 更新 Agent */
export const updateAgent = (
  agentId: string,
  data: UpdateAgentRequest,
): Promise<Agent> => {
  return request.patch(`/agents/${agentId}`, data);
};

/** 删除 Agent */
export const deleteAgent = (agentId: string): Promise<void> => {
  return request.delete(`/agents/${agentId}`);
};

// ===========================================================================
// 资源查询（前端下拉用）
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
  skills: Array<{ id: string; name: string; description: string | null; type: string }>;
  mcpServers: Array<{ id: string; name: string; description: string | null; status: string }>;
}> => {
  return request.get(`/agent/resources`);
};

// ===========================================================================
// ChatSession CRUD
// ===========================================================================

/** 列出某 Agent 下的所有会话 */
export const listSessions = (
  agentId: string,
): Promise<ChatSessionListItem[]> => {
  return request.get(`/agents/${agentId}/sessions`);
};

/** 创建新会话 */
export const createSession = (
  agentId: string,
  title?: string,
): Promise<ChatSession> => {
  return request.post(`/agents/${agentId}/sessions`, { title });
};

/** 获取会话详情 + 消息 */
export const getSession = (sessionId: string): Promise<ChatSessionDetail> => {
  return request.get(`/sessions/${sessionId}`);
};

/** 更新会话（标题） */
export const updateSession = (
  sessionId: string,
  title: string,
): Promise<ChatSession> => {
  return request.patch(`/sessions/${sessionId}`, { title });
};

/** 删除会话 */
export const deleteSession = (sessionId: string): Promise<void> => {
  return request.delete(`/sessions/${sessionId}`);
};

// ===========================================================================
// Agent SSE 流式聊天
// ===========================================================================

export interface AgentChatStreamRequest {
  input: string;
  /** Agent ID（必填） */
  agentId: string;
  /** Session ID（可选，传入则持久化 + 加载历史） */
  sessionId?: string;
}

/**
 * SSE 流式聊天 —— 推事件给前端。
 * 基于 Agent ID 从后端读取配置，不需要前端传模型/知识库等。
 *
 * 事件类型：thinking → tool_call → tool_result → message → error
 */
export const runAgentStream = async (
  data: AgentChatStreamRequest,
  onEvent: (event: AgentStreamEvent) => void,
): Promise<void> => {
  const userStore = useUserStore();
  const response = await fetch(`/api/agents/${data.agentId}/chat/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(userStore.token ? { Authorization: `Bearer ${userStore.token}` } : {}),
    },
    body: JSON.stringify({
      input: data.input,
      sessionId: data.sessionId,
    }),
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
