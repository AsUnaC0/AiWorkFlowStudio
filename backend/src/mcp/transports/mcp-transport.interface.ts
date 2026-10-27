import type {
  McpServerRuntimeConfig,
  McpTool,
  McpToolCallResult,
  McpTransportKind,
  McpTransportLimits,
  McpTransportSession,
} from '../types/mcp.types';

/**
 * MCP 传输层抽象。
 *
 * 上层（McpConnectionService / McpToolService）只依赖这个接口，
 * 不关心底下是 Streamable HTTP、旧版 HTTP + SSE 还是本地 stdio 子进程 ——
 * 三者的连接流程、消息分帧、响应解析和会话管理完全不同，因此各自独立实现。
 */
export interface McpTransport {
  /** 传输类型标识，用于日志与错误信息 */
  readonly kind: McpTransportKind;

  /**
   * 建立连接并完成协议握手：
   *   initialize（协议版本 / 能力协商）→ notifications/initialized
   * 返回协商后的会话信息（协议版本、sessionId、serverInfo）。
   */
  connect(): Promise<McpTransportSession>;

  /** 工具发现（内部处理分页） */
  listTools(): Promise<McpTool[]>;

  /** 工具调用，返回原始结果（content / structuredContent / isError） */
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolCallResult>;

  /** 关闭连接：释放流 / 终止会话（DELETE Mcp-Session-Id） */
  close(): Promise<void>;
}

/** 构造传输实例所需的依赖 */
export interface McpTransportContext {
  config: McpServerRuntimeConfig;
  limits: McpTransportLimits;
  /**
   * URL 安全校验（含 DNS 解析）。
   * 由 McpUrlGuardService 提供，**远程传输**在发起每个请求前调用，
   * 从而覆盖「重定向到内网」「DNS 重绑定」等场景。
   * STDIO 传输不使用它（没有 URL），它的安全边界是命令白名单与环境变量隔离。
   */
  validateUrl: (url: string) => Promise<void>;
}

/** 默认的传输预算：单请求 30s，响应体上限 4MB */
export const DEFAULT_TRANSPORT_LIMITS: McpTransportLimits = {
  timeoutMs: 30_000,
  maxResponseBytes: 4 * 1024 * 1024,
};
