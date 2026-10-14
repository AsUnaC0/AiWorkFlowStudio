import {
  McpProtocolError,
  MCP_CLIENT_INFO,
  MCP_LATEST_PROTOCOL_VERSION,
  MCP_MAX_TOOL_PAGES,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  type McpInitializeResult,
  type McpServerRuntimeConfig,
  type McpTool,
  type McpToolCallResult,
  type McpToolListResult,
  type McpTransportSession,
  type JsonRpcErrorObject,
  type JsonRpcResponse,
} from '../types/mcp.types';
import type {
  McpTransport,
  McpTransportContext,
} from './mcp-transport.interface';
import {
  openHttpRequest,
  readJsonRpcResponse,
  safeJsonParse,
  toHeaderValue,
  type OpenedResponse,
} from './mcp-http.util';

const JSON_RPC_CONTENT_TYPE = 'application/json';
const SSE_CONTENT_TYPE = 'text/event-stream';

/**
 * Streamable HTTP 传输（MCP 2025-03-26 / 2025-06-18 推荐的 HTTP 传输）。
 *
 * 与「旧版 HTTP + SSE」的区别（这正是不能只靠改 URL 切换的原因）：
 *  - 所有消息都是对同一个 MCP 端点的 POST；
 *  - 响应可能是 application/json，也可能是 text/event-stream（同一次 POST 内二选一）；
 *  - 会话通过响应头 `Mcp-Session-Id` 下发，后续请求必须回传；
 *  - 初始化后所有请求需带 `MCP-Protocol-Version` 头；
 *  - 客户端可发 `DELETE` 主动结束会话。
 */
export class StreamableHttpTransport implements McpTransport {
  readonly kind = 'STREAMABLE_HTTP' as const;

  private readonly config: McpServerRuntimeConfig;
  private readonly limits: { timeoutMs: number; maxResponseBytes: number };
  private readonly validateUrl: (url: string) => Promise<void>;

  private sessionId?: string;
  private protocolVersion?: string;
  private nextId = 1;
  private closed = false;

  constructor(context: McpTransportContext) {
    this.config = context.config;
    this.limits = context.limits;
    this.validateUrl = context.validateUrl;
  }

  async connect(): Promise<McpTransportSession> {
    const result = (await this.sendRequest('initialize', {
      protocolVersion: MCP_LATEST_PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: false } },
      clientInfo: MCP_CLIENT_INFO,
    })) as McpInitializeResult;

    if (!result || typeof result !== 'object') {
      throw new McpProtocolError('MCP initialize 返回体格式不正确');
    }

    // 1. 校验服务端返回的协议版本
    const negotiated = String(result.protocolVersion ?? '');
    if (!negotiated) {
      throw new McpProtocolError('MCP Server 未返回 protocolVersion');
    }
    if (!this.isSupportedProtocolVersion(negotiated)) {
      throw new McpProtocolError(
        `MCP Server 返回了不支持的协议版本 ${negotiated}，客户端支持：${MCP_SUPPORTED_PROTOCOL_VERSIONS.join(' / ')}`,
      );
    }
    this.protocolVersion = negotiated;

    // 2. 发送 notifications/initialized（必须发，不能只 initialize 就认为连接完成）
    await this.sendNotification('notifications/initialized');

    return {
      protocolVersion: negotiated,
      sessionId: this.sessionId,
      serverInfo: result.serverInfo,
      capabilities: result.capabilities,
      instructions: result.instructions,
    };
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    let page = 0;

    do {
      const params: Record<string, unknown> = {};
      if (cursor) params.cursor = cursor;

      const result = (await this.sendRequest(
        'tools/list',
        params,
      )) as McpToolListResult;

      if (result && Array.isArray(result.tools)) {
        tools.push(
          ...result.tools.filter((t) => t && typeof t.name === 'string'),
        );
      }

      cursor =
        typeof result?.nextCursor === 'string' && result.nextCursor.length > 0
          ? result.nextCursor
          : undefined;

      page += 1;
      if (page >= MCP_MAX_TOOL_PAGES) break;
    } while (cursor);

    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolCallResult> {
    const result = (await this.sendRequest('tools/call', {
      name,
      arguments: args ?? {},
    })) as McpToolCallResult;

    if (!result || typeof result !== 'object') {
      throw new McpProtocolError('tools/call 返回体格式不正确');
    }
    return result;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (!this.sessionId) return;

    // 按协议用 DELETE 主动结束会话（best-effort，失败不影响调用方）
    try {
      await this.validateUrl(this.config.serverUrl);
      const opened = await openHttpRequest(this.config.serverUrl, {
        method: 'DELETE',
        headers: this.buildHeaders(),
        timeoutMs: Math.min(this.limits.timeoutMs, 5_000),
      });
      opened.dispose();
      await opened.body?.cancel().catch(() => undefined);
    } catch {
      // 忽略
    } finally {
      this.sessionId = undefined;
    }
  }

  // ===========================================================================
  // 内部：JSON-RPC 收发
  // ===========================================================================

  private async sendRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.closed) {
      throw new McpProtocolError('连接已关闭');
    }
    await this.validateUrl(this.config.serverUrl);

    const id = this.nextId++;
    const isInitialize = method === 'initialize';

    const opened = await openHttpRequest(this.config.serverUrl, {
      method: 'POST',
      headers: this.buildHeaders(isInitialize),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      timeoutMs: this.limits.timeoutMs,
    });

    try {
      if (isInitialize) {
        this.captureSessionId(opened);
      }

      if (opened.status < 200 || opened.status >= 300) {
        throw await this.buildHttpError(opened, method);
      }

      const response = await readJsonRpcResponse(
        opened,
        id,
        this.limits.maxResponseBytes,
      );
      return this.unwrap(response, method);
    } finally {
      opened.dispose();
    }
  }

  private async sendNotification(method: string): Promise<void> {
    if (this.closed) return;
    await this.validateUrl(this.config.serverUrl);

    const opened = await openHttpRequest(this.config.serverUrl, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', method }),
      timeoutMs: this.limits.timeoutMs,
    });

    try {
      // 通知的预期响应是 202 Accepted；部分实现返回 200/204，同样接受
      if (opened.status < 200 || opened.status >= 300) {
        throw await this.buildHttpError(opened, method);
      }
    } finally {
      opened.dispose();
    }
  }

  private unwrap(response: JsonRpcResponse, method: string): unknown {
    if ('error' in response && response.error) {
      const err = response.error;
      throw new McpProtocolError(
        `MCP ${method} 失败：${err.message}（code ${err.code}）`,
        { code: err.code, data: err.data },
      );
    }
    return (response as { result?: unknown }).result;
  }

  /** 从 initialize 响应头捕获 Mcp-Session-Id */
  private captureSessionId(opened: OpenedResponse): void {
    const sessionId =
      opened.headers.get('mcp-session-id') ??
      opened.headers.get('Mcp-Session-Id');
    if (sessionId) this.sessionId = sessionId.trim();
  }

  private async buildHttpError(
    opened: OpenedResponse,
    method: string,
  ): Promise<McpProtocolError> {
    const status = opened.status;

    // 会话失效：服务端对无效 Mcp-Session-Id 返回 404，需要重新 initialize
    if (status === 404 && this.sessionId) {
      return new McpProtocolError(
        `MCP 会话已失效（HTTP 404），需要重新建立连接`,
        { code: -32000, sessionExpired: true },
      );
    }

    let detail = '';
    try {
      const text = await readBodyText(opened);
      const parsed = safeJsonParse(text);
      if (parsed && typeof parsed === 'object') {
        const err = (parsed as { error?: JsonRpcErrorObject }).error;
        if (err?.message) detail = `：${err.message}`;
      } else if (text.trim()) {
        detail = `：${text.slice(0, 200)}`;
      }
    } catch {
      // 忽略读取失败
    }

    return new McpProtocolError(
      `MCP ${method} 请求失败：HTTP ${status}${detail}`,
      { code: -status },
    );
  }

  private buildHeaders(isInitialize = false): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': JSON_RPC_CONTENT_TYPE,
      // 按协议必须同时声明两种可接受的响应类型
      Accept: `${JSON_RPC_CONTENT_TYPE}, ${SSE_CONTENT_TYPE}`,
    };

    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    // 初始化请求本身不带协议版本头；之后所有请求都要带
    if (!isInitialize && this.protocolVersion) {
      headers['MCP-Protocol-Version'] = this.protocolVersion;
    }

    const auth = this.config.authType;
    const creds = (this.config.credentials ?? {}) as Record<string, unknown>;
    const bearerToken = toHeaderValue(creds.bearerToken);
    const apiKey = toHeaderValue(creds.apiKey);
    if (auth === 'BEARER_TOKEN' && bearerToken) {
      headers.Authorization = `Bearer ${bearerToken}`;
    } else if (auth === 'API_KEY' && apiKey) {
      headers['X-API-Key'] = apiKey;
    }

    return headers;
  }

  private isSupportedProtocolVersion(version: string): boolean {
    return (MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(
      version,
    );
  }
}

async function readBodyText(opened: OpenedResponse): Promise<string> {
  if (!opened.body) return '';
  const reader = opened.body.getReader();
  try {
    const { value } = await reader.read();
    return value ? Buffer.from(value).toString('utf8') : '';
  } catch {
    return '';
  } finally {
    reader.releaseLock?.();
  }
}
