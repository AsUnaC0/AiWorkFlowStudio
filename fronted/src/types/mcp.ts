export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

export type McpTransportKind = "SSE" | "STREAMABLE_HTTP";
export type McpAuthType = "NONE" | "API_KEY" | "BEARER_TOKEN";
export type McpConnectionStatus = "DISCONNECTED" | "CONNECTED" | "ERROR";

export interface McpServer {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  transport: McpTransportKind;
  serverUrl: string;
  authType: McpAuthType;
  status: McpConnectionStatus;
  lastError: string | null;
  availableTools: McpTool[] | null;
  /** 握手协商出的协议版本（如 2025-06-18） */
  protocolVersion: string | null;
  /** 服务端自报名称 / 版本 */
  serverName: string | null;
  serverVersion: string | null;
  /** 最后一次成功连接时间 */
  lastConnectedAt: string | null;
  /** 是否已配置凭据（凭据本身不会返回前端） */
  hasCredentials: boolean;
  /** 凭据掩码预览，如 sk-a****1234 */
  credentialPreview: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMcpServerRequest {
  name: string;
  description?: string;
  transport?: McpTransportKind;
  serverUrl: string;
  authType?: McpAuthType;
  apiKey?: string;
  bearerToken?: string;
}

export interface UpdateMcpServerRequest {
  name?: string;
  description?: string;
  transport?: McpTransportKind;
  serverUrl?: string;
  authType?: McpAuthType;
  apiKey?: string;
  bearerToken?: string;
}

export interface McpServerInfo {
  name: string;
  version: string;
  title?: string;
}

export interface TestConnectionResult {
  success: boolean;
  status: "CONNECTED" | "ERROR";
  transport: McpTransportKind;
  protocolVersion?: string;
  serverInfo?: McpServerInfo | null;
  instructions?: string | null;
  tools: McpTool[];
  lastConnectedAt?: string;
  message: string;
}

export interface CallMcpToolRequest {
  toolName: string;
  arguments?: Record<string, unknown>;
}

export interface CallMcpToolResult {
  success: boolean;
  toolName: string;
  durationMs: number;
  content: string;
  structuredContent: unknown;
  isError: boolean;
}
