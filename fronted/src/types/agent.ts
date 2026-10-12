// ===========================================================================
// Agent 基础类型
// ===========================================================================

import type { GeneratedFile } from "./files";

export type AgentType = "GENERAL" | "KNOWLEDGE" | "WORKFLOW" | "TOOL" | "CUSTOM";
export type AgentStatus = "DRAFT" | "PUBLISHED" | "DISABLED";

export interface Agent {
  id: string;
  workspaceId: string | null;  // 可空：系统 Agent 不属于任何 Workspace
  createdBy: string | null;     // 可空：系统 Agent 无创建者
  name: string;
  description: string | null;
  avatar: string | null;
  type: AgentType;
  isDefault: boolean;
  isSystem: boolean;            // 系统预设 Agent（不可删除）
  status: AgentStatus;
  model: string;
  /** 关联用户在「模型管理」中添加的自定义模型 id；为空则回退 Ollama 本地 model */
  llmModelId: string | null;
  systemPrompt: string | null;
  workflowIds: string[];
  knowledgeBaseIds: string[];
  skillIds: string[];
  mcpServerIds: string[];
  maxToolIterations: number;
  temperature: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentRequest {
  name: string;
  description?: string;
  avatar?: string;
  type?: AgentType;
  model?: string;
  /** 自定义模型 id（可选，优先于 model） */
  llmModelId?: string;
  systemPrompt?: string;
  workflowIds?: string[];
  knowledgeBaseIds?: string[];
  skillIds?: string[];
  mcpServerIds?: string[];
  maxToolIterations?: number;
  temperature?: number;
}

export interface UpdateAgentRequest {
  name?: string;
  description?: string;
  avatar?: string;
  model?: string;
  /** 自定义模型 id；传空字符串表示清除（回退 Ollama 本地 model） */
  llmModelId?: string;
  systemPrompt?: string;
  workflowIds?: string[];
  knowledgeBaseIds?: string[];
  skillIds?: string[];
  mcpServerIds?: string[];
  maxToolIterations?: number;
  temperature?: number;
}

// ===========================================================================
// ChatSession 类型
// ===========================================================================

export interface ChatSession {
  id: string;
  userId: string;
  agentId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSessionListItem {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  _count: { messages: number };
}

export type ChatMessageRole = "user" | "assistant" | "system" | "tool";

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: ChatMessageRole;
  content: string;
  trail?: Record<string, unknown>[] | null;
  toolCallId?: string | null;
  createdAt: string;
  /** 本条消息关联的文件（Agent 通过 generate_file 工具产出） */
  files?: GeneratedFile[];
}

export interface ChatSessionDetail extends ChatSession {
  agent: { id: string; name: string; type: AgentType };
  messages: ChatMessage[];
}

// ===========================================================================
// Agent SSE 流事件（后端 AgentService.runStream 推送）
// ===========================================================================

export interface AgentStreamMeta {
  type: "meta";
  agentId: string;
  agentName: string;
  /** 本次实际使用的模型标识（后端解析 llmModelId 得到，未绑定时为本地 model） */
  model: string;
  provider: string;
}

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

/** Agent 通过 generate_file 工具生成的文件（前端直接渲染为文件卡片） */
export interface AgentStreamFile {
  type: "file";
  file: GeneratedFile;
}

export interface AgentStreamError {
  type: "error";
  message: string;
}

export type AgentStreamEvent =
  | AgentStreamMeta
  | AgentStreamThinking
  | AgentStreamToolCall
  | AgentStreamToolResult
  | AgentStreamMessage
  | AgentStreamFile
  | AgentStreamError;

// ===========================================================================
// Agent 模板预设（前端创建 Agent 时用）
// ===========================================================================

export interface AgentTemplate {
  type: AgentType;
  label: string;
  description: string;
  icon: string;
  defaultName: string;
}

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    type: "GENERAL",
    label: "通用助手",
    description: "直接聊天，不绑定额外能力。适合日常问答和通用任务。",
    icon: "chat",
    defaultName: "通用助手",
  },
  {
    type: "KNOWLEDGE",
    label: "知识库问答",
    description: "面向文档检索与问答。绑定知识库后，Agent 会自动检索相关内容回答。",
    icon: "library",
    defaultName: "知识库问答助手",
  },
  {
    type: "WORKFLOW",
    label: "工作流助手",
    description: "以工作流执行为主。适合数据处理、审批辅助、自动化任务等场景。",
    icon: "flow",
    defaultName: "工作流助手",
  },
  {
    type: "TOOL",
    label: "工具型助手",
    description: "使用 MCP、Skill 等工具能力。例如调用外部 API、查询业务系统。",
    icon: "link",
    defaultName: "工具型助手",
  },
  {
    type: "CUSTOM",
    label: "自定义 Agent",
    description: "自由组合模型、知识库、工作流、MCP 和 Skill。从空白配置开始。",
    icon: "setting",
    defaultName: "自定义 Agent",
  },
];
