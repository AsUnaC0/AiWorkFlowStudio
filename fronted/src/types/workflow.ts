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

export interface Workflow {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  status: string;
  currentVersionId: string | null;
  currentVersion: WorkflowVersion | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkflowRequest {
  name: string;
  description?: string;
  definition: WorkflowDefinition;
}

export interface UpdateWorkflowRequest {
  definition: WorkflowDefinition;
  name?: string;
  description?: string;
} // 节点属性配置接口，匹配文档 4.3 章节定义
export interface NodeConfig {
  label: string;
  model?: string;
  prompt?: string;
  temperature?: number;
  [key: string]: unknown;
}
