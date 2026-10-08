export interface Skill {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  type: "PROMPT" | "WORKFLOW" | "TOOL";
  instructions: string | null;
  inputSchema: unknown;
  outputFormat: string;
  workflowId: string | null;
  mcpServerId: string | null;
  mcpToolName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSkillRequest {
  name: string;
  description?: string;
  type?: "PROMPT" | "WORKFLOW" | "TOOL";
  instructions?: string;
  inputSchema?: unknown;
  outputFormat?: string;
  workflowId?: string;
  mcpServerId?: string;
  mcpToolName?: string;
}

export interface UpdateSkillRequest {
  name?: string;
  description?: string;
  type?: "PROMPT" | "WORKFLOW" | "TOOL";
  instructions?: string;
  inputSchema?: unknown;
  outputFormat?: string;
  workflowId?: string;
  mcpServerId?: string;
  mcpToolName?: string;
}

/** 输入参数行（前端编辑器用） */
export interface InputParam {
  name: string;
  type: string;
  description: string;
  required: boolean;
}
