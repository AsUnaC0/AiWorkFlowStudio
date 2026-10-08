export type AgentStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";

export interface Agent {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  model: string;
  systemPrompt: string | null;
  workflowIds: string[];
  knowledgeBaseIds: string[];
  maxToolIterations: number;
  temperature: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentRequest {
  name: string;
  description?: string;
  model?: string;
  systemPrompt?: string;
  workflowIds?: string[];
  knowledgeBaseIds?: string[];
  maxToolIterations?: number;
  temperature?: number;
}

export interface UpdateAgentRequest {
  name?: string;
  description?: string;
  model?: string;
  systemPrompt?: string;
  workflowIds?: string[];
  knowledgeBaseIds?: string[];
  maxToolIterations?: number;
  temperature?: number;
}

// ===========================================================================
// Agent SSE 流事件（后端 AgentService.runStream 推送）
// ===========================================================================

export interface AgentStreamThinking {
  type: "thinking";
  message: string;
}

export interface AgentStreamToolCall {
  type: "tool_call";
  tool: string;
  args: Record<string, unknown>;
}

export interface AgentStreamToolResult {
  type: "tool_result";
  tool: string;
  result: string;
  durationMs: number;
}

export interface AgentStreamMessage {
  type: "message";
  content: string;
}

export interface AgentStreamError {
  type: "error";
  message: string;
}

export type AgentStreamEvent =
  | AgentStreamThinking
  | AgentStreamToolCall
  | AgentStreamToolResult
  | AgentStreamMessage
  | AgentStreamError;
