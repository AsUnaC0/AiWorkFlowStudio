import { Injectable, Logger } from '@nestjs/common';
import type { ToolDefinition } from '../ai/ai-provider.interface';
import type {
  PlatformOperationStatus,
  PlatformTool,
  PlatformToolAction,
  PlatformToolContext,
  PlatformToolRisk,
} from './platform-tool.interface';
import { PlatformOperationLogService } from './platform-operation-log.service';
import { UserTools } from './tools/user.tools';
import { WorkspaceTools } from './tools/workspace.tools';
import { WorkflowTools } from './tools/workflow.tools';
import { KnowledgeTools } from './tools/knowledge.tools';
import { AgentTools } from './tools/agent.tools';
import { SkillMcpTools } from './tools/skill-mcp.tools';

/** 推送给前端 / 审计用的操作卡片数据（JSON 安全） */
export interface PlatformOperationPayload {
  tool: string;
  label: string;
  action: PlatformToolAction;
  riskLevel: PlatformToolRisk;
  status: PlatformOperationStatus;
  targetType?: string;
  targetId?: string;
  targetName?: string;
  summary?: string;
  link?: string;
  durationMs: number;
}

export interface PlatformToolExecution {
  /** 喂回 LLM 的文本 */
  text: string;
  /** 供前端渲染操作卡片 + 审计 */
  operation: PlatformOperationPayload;
}

/**
 * PlatformToolsService —— 平台内置工具注册中心。
 *
 * 职责：
 *   1. 汇总各领域工具（user / workspace / workflow / knowledge / agent / skill-mcp）
 *   2. 一次性构建 LLM 可见的 ToolDefinition 列表
 *   3. 按名字路由执行，并统一做：
 *        - 异常兜底（工具抛错 → 转成 FAILED 结果喂回模型，而不是中断整轮对话）
 *        - 耗时统计
 *        - 审计落库（PlatformOperationLog）
 *        - 生成前端操作卡片载荷
 *
 * 与 `agent/tool-registry.service.ts` 的分工：
 *   - ToolRegistry 管「Agent 绑定资源」动态生成的工具（workflow_xxx / knowledge_search / generate_file）
 *   - PlatformToolsService 管「平台内置」的固定工具
 *   - AgentService 先查 PlatformToolsService，未命中再交给 ToolRegistry
 */
@Injectable()
export class PlatformToolsService {
  private readonly logger = new Logger(PlatformToolsService.name);

  /** 工具名 → 工具实例 */
  private readonly registry = new Map<string, PlatformTool>();

  constructor(
    private readonly userTools: UserTools,
    private readonly workspaceTools: WorkspaceTools,
    private readonly workflowTools: WorkflowTools,
    private readonly knowledgeTools: KnowledgeTools,
    private readonly agentTools: AgentTools,
    private readonly skillMcpTools: SkillMcpTools,
    private readonly operationLog: PlatformOperationLogService,
  ) {
    for (const tool of this.allTools()) {
      if (this.registry.has(tool.name)) {
        this.logger.error(`平台工具名冲突：${tool.name}（已忽略后注册的定义）`);
        continue;
      }
      this.registry.set(tool.name, tool);
    }
    this.logger.log(`平台工具注册完成，共 ${this.registry.size} 个`);
  }

  private allTools(): PlatformTool[] {
    return [
      ...this.userTools.tools,
      ...this.workspaceTools.tools,
      ...this.workflowTools.tools,
      ...this.knowledgeTools.tools,
      ...this.agentTools.tools,
      ...this.skillMcpTools.tools,
    ];
  }

  /** 工具名清单（调试 / 概览用） */
  listToolNames(): string[] {
    return [...this.registry.keys()];
  }

  /** 能力清单（注入 Prompt，让模型知道「我能做什么」） */
  listCapabilities(): Array<{
    name: string;
    label: string;
    action: PlatformToolAction;
    riskLevel: PlatformToolRisk;
  }> {
    return [...this.registry.values()].map((tool) => ({
      name: tool.name,
      label: tool.meta.label,
      action: tool.meta.action,
      riskLevel: tool.meta.riskLevel,
    }));
  }

  /** 是否为本注册中心管辖的平台工具 */
  isPlatformTool(name: string): boolean {
    return this.registry.has(name);
  }

  /** 构建 LLM 可见的工具定义列表 */
  buildDefinitions(): ToolDefinition[] {
    return [...this.registry.values()].map((tool) => tool.definition);
  }

  /** 执行一个平台工具（含审计与异常兜底） */
  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: PlatformToolContext,
  ): Promise<PlatformToolExecution> {
    const tool = this.registry.get(name);
    if (!tool) {
      throw new Error(`未知平台工具: ${name}`);
    }

    const startedAt = Date.now();
    let status: PlatformOperationStatus = 'SUCCESS';
    let text: string;
    let summary: string | undefined;
    let targetType: string | undefined = tool.meta.targetType;
    let targetId: string | undefined;
    let targetName: string | undefined;
    let link: string | undefined;
    let errorMessage: string | undefined;

    try {
      const outcome = await tool.execute(args, ctx);
      text = outcome.text;
      status = outcome.status ?? 'SUCCESS';
      summary = outcome.summary;
      targetType = outcome.targetType ?? targetType;
      targetId = outcome.targetId;
      targetName = outcome.targetName;
      link = outcome.link;
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      status = 'FAILED';
      text = `工具「${tool.meta.label}」执行失败：${errorMessage}`;
      this.logger.warn(`平台工具 ${name} 执行异常: ${errorMessage}`);
    }

    const durationMs = Date.now() - startedAt;

    const operation: PlatformOperationPayload = {
      tool: name,
      label: tool.meta.label,
      action: tool.meta.action,
      riskLevel: tool.meta.riskLevel,
      status,
      targetType,
      targetId,
      targetName,
      summary: summary ?? text.slice(0, 200),
      link,
      durationMs,
    };

    // 审计落库（失败不影响主流程）
    await this.operationLog.record({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      tool: name,
      action: tool.meta.action,
      riskLevel: tool.meta.riskLevel,
      targetType,
      targetId,
      targetName,
      status,
      summary: operation.summary,
      link,
      params: args,
      errorMessage,
      durationMs,
    });

    return { text, operation };
  }
}
