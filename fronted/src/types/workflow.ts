import type { Edge, Node } from "@vue-flow/core";

export interface WorkflowDefinition {
  nodes: Node[];
  edges: Edge[];
}

export interface WorkflowVersion {
  id: string;
  version: number;
  definition: WorkflowDefinition;
  createdAt: string;
}

export type WorkflowStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";

export interface Workflow {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  currentVersionId: string | null;
  publishedVersionId: string | null;
  currentVersion: WorkflowVersion | null;
  publishedVersion: WorkflowVersion | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkflowRequest {
  name: string;
  description?: string;
  definition: WorkflowDefinition;
}

export interface UpdateWorkflowRequest {
  /**
   * 画布内容。可选 —— 不传则只更新 name / description，
   * 不会产生新的 WorkflowVersion（列表页重命名走这条路）。
   */
  definition?: WorkflowDefinition;
  name?: string;
  description?: string;
} // 节点属性配置接口，匹配文档 4.3 章节定义
export interface NodeConfig {
  label: string;
  model?: string;
  /** 关联用户在「模型管理」中添加的自定义模型 id（优先于 model）；不传则回退 Ollama 本地 model */
  llmModelId?: string;
  prompt?: string;
  temperature?: number;
  [key: string]: unknown;
}
