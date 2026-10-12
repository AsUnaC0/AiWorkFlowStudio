import { Injectable } from '@nestjs/common';
import type { ToolDefinition } from '../ai/ai-provider.interface';
import { WorkflowTool } from './tools/workflow.tool';
import { KnowledgeTool } from './tools/knowledge.tool';
import {
  GenerateFileTool,
  GENERATE_FILE_TOOL_NAME,
} from './tools/generate-file.tool';
import type { ToolContext } from './tools/agent-tool.interface';

/**
 * ToolRegistry — Agent 工具注册中心。
 *
 * 负责：
 *   1. 根据 Agent 配置动态构建所有 ToolDefinition（LLM 可见的 schema）
 *   2. 根据 toolCall.function.name 路由到正确的 Tool.execute
 *   3. 解析 function.name 前缀拿到 context.workflowId 等
 */
@Injectable()
export class ToolRegistry {
  constructor(
    private readonly workflowTool: WorkflowTool,
    private readonly knowledgeTool: KnowledgeTool,
    private readonly generateFileTool: GenerateFileTool,
  ) {}

  /**
   * 根据 Agent 配置构建完整的工具定义列表。
   * 每个已发布 Workflow → 一个独立 Tool；KnowledgeBase → 一个综合 Tool。
   * `generate_file` 为内置能力，由 enableFileGeneration 控制。
   */
  async buildDefinitions(
    workflowIds: string[],
    knowledgeBaseIds: string[],
    options: { enableFileGeneration?: boolean } = {},
  ): Promise<ToolDefinition[]> {
    const workflowDefs = await this.workflowTool.buildDefinitions(workflowIds);
    const knowledgeDefs =
      await this.knowledgeTool.buildDefinitions(knowledgeBaseIds);

    const defs: ToolDefinition[] = [...workflowDefs, ...knowledgeDefs];

    if (options.enableFileGeneration !== false) {
      defs.push(this.generateFileTool.buildDefinition());
    }

    return defs;
  }

  /**
   * 执行一个 tool_call。
   * 根据 function.name 前缀路由：
   *   - `workflow_{uuid}` → WorkflowTool
   *   - `knowledge_search` → KnowledgeTool
   *   - `generate_file`     → GenerateFileTool
   */
  async executeTool(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext & { knowledgeBaseIds?: string[] },
  ): Promise<string> {
    // Workflow 工具：workflow_{workflowId}
    const workflowMatch = toolName.match(/^workflow_([0-9a-f-]{36})$/i);
    if (workflowMatch) {
      const workflowId = workflowMatch[1];
      return this.workflowTool.execute(args, { ...context, workflowId });
    }

    // Knowledge 工具
    if (toolName === 'knowledge_search') {
      return this.knowledgeTool.execute(args, context);
    }

    // 文件生成工具
    if (toolName === GENERATE_FILE_TOOL_NAME) {
      return this.generateFileTool.execute(args, context);
    }

    throw new Error(`未知工具: ${toolName}`);
  }
}
