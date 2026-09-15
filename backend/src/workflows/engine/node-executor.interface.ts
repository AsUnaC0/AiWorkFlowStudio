export interface NodeExecutionContext {
  input: unknown;
  data: Record<string, unknown>;
  previousOutput?: unknown;
}

export interface NodeExecutionResult {
  output: unknown;
}

export interface NodeExecutor {
  execute(
    context: NodeExecutionContext,
    node: any,
  ): Promise<NodeExecutionResult>;
}
