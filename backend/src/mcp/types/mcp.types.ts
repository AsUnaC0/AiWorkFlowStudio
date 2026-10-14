/**
 * MCP（Model Context Protocol）协议类型定义。
 *
 * 只覆盖平台当前需要的子集：initialize / notifications/initialized /
 * tools/list / tools/call，以及传输层需要的会话信息。
 *
 * 参考协议版本：2024-11-05（旧版 HTTP+SSE）、2025-03-26、2025-06-18（Streamable HTTP）。
 */

/** 客户端支持的协议版本，按新→旧排列（协商时优先用最新） */
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;

/** 默认请求的协议版本 */
export const MCP_LATEST_PROTOCOL_VERSION = MCP_SUPPORTED_PROTOCOL_VERSIONS[0];

/** 客户端标识，initialize 时上报给服务端 */
export const MCP_CLIENT_INFO = {
  name: 'ai-workflow-studio',
  title: 'AI WorkFlow Studio',
  version: '1.0.0',
} as const;

/** 一次 tools/list 的分页保护上限，防止服务端 nextCursor 死循环 */
export const MCP_MAX_TOOL_PAGES = 20;

// ===========================================================================
// 枚举
// ===========================================================================

export type McpTransportKind = 'STREAMABLE_HTTP' | 'SSE';
export type McpAuthType = 'NONE' | 'API_KEY' | 'BEARER_TOKEN';
export type McpConnectionStatus =
  'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'ERROR';

// ===========================================================================
// JSON-RPC 2.0
// ===========================================================================

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: number | string | null;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: number | string | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** 标准 JSON-RPC 错误码 */
export const JsonRpcErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

// ===========================================================================
// MCP 业务对象
// ===========================================================================

/** 工具入参/出参 JSON Schema（保持宽松，原样透传给模型） */
export interface McpJsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

/** tools/list 返回的单个工具 */
export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: McpJsonSchema;
  outputSchema?: McpJsonSchema;
  annotations?: Record<string, unknown>;
}

/** tools/list 返回体 */
export interface McpToolListResult {
  tools: McpTool[];
  nextCursor?: string;
}

/** tools/call 返回的内容块 */
export interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  [key: string]: unknown;
}

/** tools/call 返回体 */
export interface McpToolCallResult {
  content?: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

/** initialize 返回体 */
export interface McpInitializeResult {
  protocolVersion: string;
  capabilities?: Record<string, unknown>;
  serverInfo?: { name: string; version: string; title?: string };
  instructions?: string;
}

// ===========================================================================
// 传输 / 会话
// ===========================================================================

/** 建立一个 MCP 连接所需的运行时配置（凭据已解密） */
export interface McpServerRuntimeConfig {
  /** 数据库主键；工作流/Agent 链路会带上，用于会话缓存 key */
  id?: string;
  transport: string;
  serverUrl: string;
  authType: string;
  credentials: unknown;
  /**
   * 上次连接成功后缓存的工具列表。
   * 有缓存时优先复用（避免每次模型调用都重新握手），
   * 需要最新列表时由用户点「刷新工具」或调用 listTools 实时发现。
   */
  cachedTools?: McpTool[];
}

/** 握手成功后的会话快照 */
export interface McpTransportSession {
  protocolVersion: string;
  /** Streamable HTTP 服务端下发的 Mcp-Session-Id（旧版 SSE 传输没有） */
  sessionId?: string;
  serverInfo?: { name: string; version: string; title?: string };
  capabilities?: Record<string, unknown>;
  instructions?: string;
}

/** 传输层单次请求可用的预算（超时 / 响应大小） */
export interface McpTransportLimits {
  timeoutMs: number;
  maxResponseBytes: number;
}

// ===========================================================================
// 错误
// ===========================================================================

/**
 * MCP 协议层错误。
 * - code 为 JSON-RPC 错误码；HTTP 层的失败用 code = httpStatus 的负数表示。
 * - sessionExpired 用于标记「会话已失效，需要重新 initialize」。
 */
export class McpProtocolError extends Error {
  readonly code: number;
  readonly data?: unknown;
  readonly sessionExpired: boolean;

  constructor(
    message: string,
    options: { code?: number; data?: unknown; sessionExpired?: boolean } = {},
  ) {
    super(message);
    this.name = 'McpProtocolError';
    this.code = options.code ?? JsonRpcErrorCode.INTERNAL_ERROR;
    this.data = options.data;
    this.sessionExpired = options.sessionExpired ?? false;
  }
}

/** 连接 / 传输层错误（URL 校验、网络、超时、响应过大等） */
export class McpTransportError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'McpTransportError';
    this.status = status;
  }
}

/** 判断错误是否属于「会话失效，可重连重试」 */
export function isSessionExpiredError(err: unknown): boolean {
  if (err instanceof McpProtocolError) return err.sessionExpired;
  if (err instanceof McpTransportError) return err.status === 404;
  return false;
}
