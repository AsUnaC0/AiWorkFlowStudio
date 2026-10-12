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

/** 生成文件的简要信息（AgentService 用它推送 SSE 事件、关联聊天消息） */
export interface GeneratedFileRef {
  id: string;
  fileName: string;
  format: string;
  extension: string;
  mimeType: string;
  size: number;
  status: string;
  previewType: string;
  title: string | null;
  summary: string | null;
  sourceType: string;
  createdAt: Date;
}

/** 工具执行上下文：提供运行时依赖 */
export interface ToolContext {
  /** 执行工具的 Agent ID */
  agentId: string;
  /** 执行用户 ID */
  userId: string;
  /** 当前会话 ID（用于把生成文件归属到会话 / 消息） */
  sessionId?: string;
  /**
   * 本次运行已生成的文件收集器。
   * generate_file 工具会把结果 push 进来，AgentService 据此推送 SSE 事件并回填 messageId。
   */
  files?: GeneratedFileRef[];
}
