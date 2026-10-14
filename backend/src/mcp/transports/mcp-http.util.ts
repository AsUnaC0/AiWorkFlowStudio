import { McpTransportError, type JsonRpcResponse } from '../types/mcp.types';

/**
 * MCP 传输层共用的 HTTP / SSE 工具。
 *
 * 设计要点（安全 + 健壮性）：
 *  - 禁止自动重定向（redirect: 'manual'），3xx 一律视为错误，
 *    避免服务端 302 到内网地址绕过 SSRF 校验。
 *  - 每个请求带超时（AbortController），超时可关闭（timeoutMs = 0）供 SSE 长连接使用。
 *  - 响应体按 maxBytes 截断保护，防止超大响应打爆内存。
 *  - 同时支持 application/json 与 text/event-stream 两种响应体解析，
 *    且 SSE 流「找到目标响应即停」，不会因为服务端不主动关闭连接而挂住。
 */

export interface HttpRequestOptions {
  method?: string;
  headers: Record<string, string>;
  body?: string;
  /** 单请求超时；0 表示不设超时（SSE 长连接） */
  timeoutMs: number;
  /** 外部取消信号 */
  signal?: AbortSignal;
}

export interface OpenedResponse {
  status: number;
  headers: Headers;
  contentType: string;
  body: ReadableStream<Uint8Array> | null;
  /** 释放超时定时器与外部监听（务必在 finally 中调用） */
  dispose: () => void;
}

/** 发起请求并返回未消费的响应（流式友好） */
export async function openHttpRequest(
  url: string,
  options: HttpRequestOptions,
): Promise<OpenedResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const timer =
    options.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, options.timeoutMs)
      : undefined;

  const onExternalAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onExternalAbort);

  const dispose = () => {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (err) {
    dispose();
    if (timedOut) {
      throw new McpTransportError(
        `MCP 请求超时（${options.timeoutMs}ms）：${url}`,
      );
    }
    if (options.signal?.aborted) {
      throw new McpTransportError('MCP 请求已被取消');
    }
    throw new McpTransportError(
      `MCP 请求失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (response.status >= 300 && response.status < 400) {
    dispose();
    throw new McpTransportError(
      `MCP Server 返回重定向（HTTP ${response.status}），已拒绝跟随以确保安全`,
      response.status,
    );
  }

  return {
    status: response.status,
    headers: response.headers,
    contentType: response.headers.get('content-type') ?? '',
    body: response.body,
    dispose,
  };
}

/** 把流读成文本，并做大小限制 */
export async function readStreamText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  onTimeoutMessage = 'MCP 响应读取超时',
): Promise<string> {
  if (!body) return '';

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new McpTransportError(
          `MCP 响应体超过上限（${Math.round(maxBytes / 1024)}KB），已中断读取`,
        );
      }
      chunks.push(Buffer.from(value));
    }
  } catch (err) {
    if (err instanceof McpTransportError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new McpTransportError(onTimeoutMessage);
    }
    throw new McpTransportError(
      `MCP 响应读取失败：${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    reader.releaseLock?.();
  }

  return Buffer.concat(chunks).toString('utf8');
}

// ===========================================================================
// SSE 解析
// ===========================================================================

export interface SseEvent {
  /** event: 字段；缺省为 'message' */
  event: string;
  /** data: 字段（多行以 \n 连接） */
  data: string;
}

/**
 * 增量解析 SSE 流。
 * `stopWhen` 返回 true 时立即取消读取（用于「拿到目标响应就停」）。
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  options: {
    maxBytes?: number;
    stopWhen?: (event: SseEvent) => boolean;
  } = {},
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  const maxBytes = options.maxBytes ?? Infinity;
  let buffer = '';
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          throw new McpTransportError(
            `MCP SSE 流超过上限（${Math.round(maxBytes / 1024)}KB）`,
          );
        }
        buffer += decoder.decode(value, { stream: true });
      }

      let boundary = findEventBoundary(buffer);
      while (boundary.index >= 0) {
        const rawEvent = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const parsed = parseSseBlock(rawEvent);
        if (parsed) {
          yield parsed;
          if (options.stopWhen?.(parsed)) {
            await reader.cancel().catch(() => undefined);
            return;
          }
        }
        boundary = findEventBoundary(buffer);
      }
    }

    const tail = parseSseBlock(buffer);
    if (tail) yield tail;
  } catch (err) {
    if (err instanceof McpTransportError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new McpTransportError('MCP SSE 连接已中断');
    }
    throw new McpTransportError(
      `MCP SSE 解析失败：${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    reader.releaseLock?.();
  }
}

function findEventBoundary(buffer: string): { index: number; length: number } {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0 && crlf < 0) return { index: -1, length: 0 };
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function parseSseBlock(block: string): SseEvent | null {
  if (!block.trim()) return null;

  let event = 'message';
  const dataLines: string[] = [];

  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    const colonIndex = rawLine.indexOf(':');
    const field = colonIndex === -1 ? rawLine : rawLine.slice(0, colonIndex);
    let value = colonIndex === -1 ? '' : rawLine.slice(colonIndex + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

// ===========================================================================
// JSON-RPC 响应解析
// ===========================================================================

/** 判断一个值是否是 JSON-RPC 响应（带 id + result/error） */
export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (obj.jsonrpc !== '2.0') return false;
  if (!('id' in obj)) return false;
  return 'result' in obj || 'error' in obj;
}

/**
 * 从「已打开的响应」中解析出 id 匹配的 JSON-RPC 响应。
 *
 * - application/json      → 读取整体文本后解析
 * - text/event-stream     → 在 SSE 流中找到 id 匹配的响应后立即停止读取
 */
export async function readJsonRpcResponse(
  opened: OpenedResponse,
  expectedId: number | string,
  maxBytes: number,
): Promise<JsonRpcResponse> {
  const contentType = opened.contentType.toLowerCase();

  if (contentType.includes('text/event-stream')) {
    if (!opened.body) {
      throw new McpTransportError('MCP Server 返回了空的 SSE 响应体');
    }
    for await (const event of parseSseStream(opened.body, {
      maxBytes,
      stopWhen: (e) => {
        if (e.event !== 'message') return false;
        const parsed = safeJsonParse(e.data);
        return (
          isJsonRpcResponse(parsed) && String(parsed.id) === String(expectedId)
        );
      },
    })) {
      if (event.event !== 'message') continue;
      const parsed = safeJsonParse(event.data);
      if (
        isJsonRpcResponse(parsed) &&
        String(parsed.id) === String(expectedId)
      ) {
        return parsed;
      }
    }
    throw new McpTransportError(
      'MCP Server 的 SSE 响应中未找到匹配的 JSON-RPC 响应',
    );
  }

  const text = await readStreamText(opened.body, maxBytes);
  if (!text.trim()) {
    throw new McpTransportError(
      `MCP Server 返回空响应（HTTP ${opened.status}）`,
      opened.status,
    );
  }

  const parsed = safeJsonParse(text);
  if (parsed === undefined) {
    throw new McpTransportError(
      `MCP Server 返回的不是合法 JSON（HTTP ${opened.status}）：${text.slice(0, 200)}`,
      opened.status,
    );
  }
  if (!isJsonRpcResponse(parsed)) {
    throw new McpTransportError(
      `MCP Server 返回的不是合法 JSON-RPC 响应：${text.slice(0, 200)}`,
      opened.status,
    );
  }
  return parsed;
}

export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** 把凭据值安全地转成请求头字符串（非字符串/数字一律忽略） */
export function toHeaderValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}
