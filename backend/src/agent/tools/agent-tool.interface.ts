import type { ToolDefinition } from '../../ai/ai-provider.interface';

/**
 * Agent Tool 统一接口。
 * 每个 Tool 负责：
 *   1. 暴露一个 ToolDefinition（LLM 可见的 schema）
 *   2. 实现 execute：接收解析好的参数对象，返回字符串结果
 *
 * 设计目标：让 AgentService 的 ReAct 循环不需要知道任何具体工具的实现。
 */
export interface AgentTool {
  /** LLM 可见的工具定义（函数名、描述、参数 schema） */
  readonly definition: ToolDefinition;

  /** 执行工具，返回结果（会被作为 tool message 喂回 LLM） */
  execute(args: Record<string, unknown>, context: ToolContext): Promise<string>;
}

/** 工具执行上下文：提供运行时依赖 */
export interface ToolContext {
  /** 执行工具的 Agent ID */
  agentId: string;
  /** 执行用户 ID */
  userId: string;
}
