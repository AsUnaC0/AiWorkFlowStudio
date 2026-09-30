export interface NodeExecutionContext {
  input: unknown;
  data: Record<string, unknown>;
  previousOutput?: unknown;
}

export interface NodeExecutionResult {
  output: unknown;

  /**
   * 节点执行后的分支标识
   * 普通节点为空
   * Condition 节点使用 'true' | 'false'
   */
  branch?: string;

  /**
   * 可选执行元数据（调试信息等）
   */
  metadata?: Record<string, unknown>;
}

export interface NodeExecutor {
  execute(
    context: NodeExecutionContext,
    node: any,
  ): Promise<NodeExecutionResult>;
}
