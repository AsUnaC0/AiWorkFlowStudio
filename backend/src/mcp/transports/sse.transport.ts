import {
  McpProtocolError,
  MCP_CLIENT_INFO,
  MCP_MAX_TOOL_PAGES,
  type McpInitializeResult,
  type McpServerRuntimeConfig,
  type McpTool,
  type McpToolCallResult,
  type McpToolListResult,
  type McpTransportSession,
  type JsonRpcErrorObject,
} from '../types/mcp.types';
import type {
  McpTransport,
  McpTransportContext,
} from './mcp-transport.interface';
import {
  openHttpRequest,
  parseSseStream,
  safeJsonParse,
  toHeaderValue,
} from './mcp-http.util';

/** 旧版 HTTP + SSE 使用的协议版本 */
const LEGACY_PROTOCOL_VERSION = '2024-11-05';
/** 等待服务端下发 endpoint 事件的超时 */
const ENDPOINT_WAIT_MS = 10_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * 旧版 HTTP + SSE 传输（MCP 2024-11-05）。
 *
 * 连接流程与 Streamable HTTP 完全不同，因此是独立实现：
 *  1. GET 建立 SSE 长连接，服务端首先下发 `endpoint` 事件（POST 目标地址）；
 *  2. 之后所有请求都 POST 到该 endpoint，服务端只回 202；
 *  3. 真正的 JSON-RPC 响应通过 SSE 流的 `message` 事件异步返回，按 id 关联。
 */
export class SseTransport implements McpTransport {
  readonly kind = 'SSE' as const;

  private readonly config: McpServerRuntimeConfig;
  private readonly limits: { timeoutMs: number; maxResponseBytes: number };
  private readonly validateUrl: (url: string) => Promise<void>;

  private abortController?: AbortController;
  private endpointUrl?: string;
  private endpointPromise?: Promise<string>;
  private resolveEndpoint?: (url: string) => void;
  private rejectEndpoint?: (err: Error) => void;
  private readLoop?: Promise<void>;
  private readonly pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private closed = false;

  constructor(context: McpTransportContext) {
    this.config = context.config;
    this.limits = context.limits;
    this.validateUrl = context.validateUrl;
  }

  async connect(): Promise<McpTransportSession> {
    await this.validateUrl(this.config.serverUrl);
    await this.openStream();

    const result = (await this.sendRequest('initialize', {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: false } },
      clientInfo: MCP_CLIENT_INFO,
    })) as McpInitializeResult;

    if (!result || typeof result !== 'object') {
      throw new McpProtocolError('MCP initialize 返回体格式不正确');
    }

    // 旧版 SSE 协议版本固定为 2024-11-05；服务端返回其他版本时以服务端为准（仅提示）
    const negotiated = String(
      result.protocolVersion ?? LEGACY_PROTOCOL_VERSION,
    );

    // 通知不需要响应（服务端回 202），但仍需发送
    await this.sendNotification('notifications/initialized');

    return {
      protocolVersion: negotiated,
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

    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new McpProtocolError('SSE 连接已关闭'));
    }
    this.pending.clear();

    this.abortController?.abort();
    this.abortController = undefined;

    try {
      await this.readLoop;
    } catch {
      // 忽略
    }
  }

  // ===========================================================================
  // 内部：SSE 长连接
  // ===========================================================================

  private async openStream(): Promise<void> {
    this.abortController = new AbortController();
    this.endpointPromise = new Promise<string>((resolve, reject) => {
      this.resolveEndpoint = resolve;
      this.rejectEndpoint = reject;
    });

    const opened = await openHttpRequest(this.config.serverUrl, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...this.buildAuthHeaders(),
      },
      // SSE 是长连接，不设整体超时，靠外部 signal 控制生命周期
      timeoutMs: 0,
      signal: this.abortController.signal,
    });

    if (opened.status < 200 || opened.status >= 300) {
      opened.dispose();
      throw new McpProtocolError(`无法建立 SSE 连接：HTTP ${opened.status}`, {
        code: -opened.status,
      });
    }
    if (!opened.body) {
      opened.dispose();
      throw new McpProtocolError('MCP SSE 响应没有可读流');
    }

    // 后台持续消费 SSE 事件
    this.readLoop = this.consume(opened.body, opened.dispose);

    // 等待 endpoint 事件
    const endpointTimer = setTimeout(() => {
      this.rejectEndpoint?.(
        new McpProtocolError(
          `等待 MCP SSE endpoint 事件超时（${ENDPOINT_WAIT_MS}ms）`,
        ),
      );
    }, ENDPOINT_WAIT_MS);

    try {
      this.endpointUrl = await this.endpointPromise;
    } finally {
      clearTimeout(endpointTimer);
    }
  }

  private async consume(
    body: ReadableStream<Uint8Array>,
    dispose: () => void,
  ): Promise<void> {
    try {
      for await (const event of parseSseStream(body, {
        maxBytes: this.limits.maxResponseBytes * 4,
      })) {
        if (event.event === 'endpoint') {
          this.handleEndpoint(event.data);
          continue;
        }
        if (event.event !== 'message') continue;
        this.handleMessage(event.data);
      }
      // 流结束：如果不是主动关闭，说明服务端断开
      if (!this.closed) {
        this.failAllPending(new McpProtocolError('MCP SSE 连接已被服务端关闭'));
      }
    } catch (err) {
      if (!this.closed) {
        this.failAllPending(
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    } finally {
      dispose();
    }
  }

  private handleEndpoint(data: string): void {
    if (this.endpointUrl) return;
    try {
      // endpoint 可能是相对路径，需要基于 SSE URL 解析
      const resolved = new URL(data.trim(), this.config.serverUrl).toString();
      this.resolveEndpoint?.(resolved);
    } catch {
      this.rejectEndpoint?.(
        new McpProtocolError(`MCP SSE 下发的 endpoint 无效：${data}`),
      );
    }
  }

  private handleMessage(data: string): void {
    const parsed = safeJsonParse(data);
    if (!parsed || typeof parsed !== 'object') return;
    const message = parsed as Record<string, unknown>;

    // 响应：id + result/error
    if ('id' in message && ('result' in message || 'error' in message)) {
      const key = String(message.id);
      const pending = this.pending.get(key);
      if (!pending) return;
      this.pending.delete(key);
      clearTimeout(pending.timer);

      if ('error' in message && message.error) {
        const err = message.error as JsonRpcErrorObject;
        pending.reject(
          new McpProtocolError(
            `MCP 调用失败：${err.message}（code ${err.code}）`,
            { code: err.code, data: err.data },
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    // 服务端 → 客户端的请求：本平台暂不支持，回一个 Method not found 避免对端挂起
    if ('method' in message && 'id' in message) {
      void this.replyMethodNotFound(String(message.id), String(message.method));
    }
  }

  // ===========================================================================
  // 内部：JSON-RPC 收发
  // ===========================================================================

  private async sendRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.closed) throw new McpProtocolError('连接已关闭');

    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    const responsePromise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(
          new McpProtocolError(
            `MCP ${method} 等待响应超时（${this.limits.timeoutMs}ms）`,
          ),
        );
      }, this.limits.timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
    });

    try {
      await this.post(payload);
    } catch (err) {
      const pending = this.pending.get(String(id));
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(String(id));
      }
      throw err;
    }

    return responsePromise;
  }

  private async sendNotification(method: string): Promise<void> {
    if (this.closed) return;
    await this.post(JSON.stringify({ jsonrpc: '2.0', method }));
  }

  /** POST 一条消息到 endpoint（服务端只回 202，真正的响应走 SSE） */
  private async post(payload: string): Promise<void> {
    const endpoint = this.endpointUrl;
    if (!endpoint) {
      throw new McpProtocolError('MCP SSE 尚未收到 endpoint 事件');
    }
    // endpoint 可能指向另一个主机，必须单独做安全校验
    await this.validateUrl(endpoint);

    const opened = await openHttpRequest(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...this.buildAuthHeaders(),
      },
      body: payload,
      timeoutMs: this.limits.timeoutMs,
    });

    try {
      if (opened.status < 200 || opened.status >= 300) {
        throw new McpProtocolError(`MCP 消息投递失败：HTTP ${opened.status}`, {
          code: -opened.status,
        });
      }
    } finally {
      opened.dispose();
      await opened.body?.cancel().catch(() => undefined);
    }
  }

  private async replyMethodNotFound(id: string, method: string): Promise<void> {
    try {
      await this.post(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        }),
      );
    } catch {
      // best-effort
    }
  }

  private failAllPending(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private buildAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    const creds = (this.config.credentials ?? {}) as Record<string, unknown>;
    const bearerToken = toHeaderValue(creds.bearerToken);
    const apiKey = toHeaderValue(creds.apiKey);
    if (this.config.authType === 'BEARER_TOKEN' && bearerToken) {
      headers.Authorization = `Bearer ${bearerToken}`;
    } else if (this.config.authType === 'API_KEY' && apiKey) {
      headers['X-API-Key'] = apiKey;
    }
    return headers;
  }
}
