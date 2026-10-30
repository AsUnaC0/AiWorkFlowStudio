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
  AgentStreamMeta,
  AgentOperation,
} from "@/types/agent";

// 便于消费方直接从 @/api/agent 引入这些类型
export type {
  Agent,
  CreateAgentRequest,
  UpdateAgentRequest,
  ChatSession,
  ChatSessionListItem,
  ChatSessionDetail,
  ChatMessage,
  AgentStreamEvent,
  AgentStreamMeta,
  AgentOperation,
};

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

/** 可绑定的 Skill（PROMPT / WORKFLOW / TOOL 三类） */
export interface AgentResourceSkill {
  id: string;
  name: string;
  description: string | null;
  type: string;
}

/** 可绑定的 MCP Server（status 用于提示「还没连上」） */
export interface AgentResourceMcpServer {
  id: string;
  name: string;
  description: string | null;
  status: "CONNECTED" | "DISCONNECTED" | "ERROR";
}

/** 内置联网搜索状态（环境变量配了 Key 才启用，不可在页面里开关） */
export interface AgentWebSearchCapability {
  enabled: boolean;
  provider: "bocha" | "tavily" | null;
}

export const getAgentResources = async (): Promise<{
  workflows: AgentResourceWorkflow[];
  knowledgeBases: AgentResourceKnowledgeBase[];
  skills: AgentResourceSkill[];
  mcpServers: AgentResourceMcpServer[];
  webSearch: AgentWebSearchCapability;
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
  /** 随消息上传的附件 ID 列表（后端会解析内容并注入 AI 上下文） */
  attachmentIds?: string[];
  /**
   * 当前工作空间 ID（可选）。
   * 仅作为「用户意图」传给后端 —— 后端会重新校验成员关系后才采用。
   */
  workspaceId?: string;
}

/**
 * SSE 流式聊天 —— 推事件给前端。
 * 基于 Agent ID 从后端读取配置，不需要前端传模型/知识库等。
 *
 * 事件类型：meta → thinking → reasoning → tool_call → tool_result → operation → file → message → error
 *
 * @param signal 可选的中止信号。页面被真正销毁（登出、跳转到独立路由）时
 *               应 abort，避免流继续消费 token 却无人接收。
 *               注意：被 keep-alive 缓存的页面切换菜单**不会**销毁组件，
 *               不要在这种情况下 abort。
 */
export const runAgentStream = async (
  data: AgentChatStreamRequest,
  onEvent: (event: AgentStreamEvent) => void,
  signal?: AbortSignal,
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
      attachmentIds: data.attachmentIds ?? [],
      workspaceId: data.workspaceId,
    }),
    signal,
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
