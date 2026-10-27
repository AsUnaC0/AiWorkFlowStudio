import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { McpUrlGuardService } from './mcp-url-guard.service';
import { StreamableHttpTransport } from './transports/streamable-http.transport';
import { SseTransport } from './transports/sse.transport';
import { StdioTransport } from './transports/stdio.transport';
import {
  DEFAULT_TRANSPORT_LIMITS,
  type McpTransport,
} from './transports/mcp-transport.interface';
import {
  isSessionExpiredError,
  McpProtocolError,
  type McpServerRuntimeConfig,
  type McpTransportSession,
} from './types/mcp.types';

export interface McpConnection {
  transport: McpTransport;
  session: McpTransportSession;
  connectedAt: number;
}

/**
 * MCP 连接生命周期管理。
 *
 * 职责：
 *  - 按 Server 配置创建对应的传输实现（Streamable HTTP / SSE）；
 *  - 完成 initialize 握手与协议协商，缓存会话供后续 tools/list、tools/call 复用；
 *  - 会话失效（服务端返回 404）时销毁并允许重连；
 *  - 并发去重：同一 Server 同时发起多次调用只做一次握手。
 *
 * 之所以要缓存会话：Streamable HTTP 的 Mcp-Session-Id 与 SSE 的长连接都是有状态的，
 * 每次工具调用都重新握手既慢又容易触发服务端限流。
 */
@Injectable()
export class McpConnectionService {
  private readonly logger = new Logger(McpConnectionService.name);

  private readonly cache = new Map<string, McpConnection>();
  private readonly pendingConnects = new Map<string, Promise<McpConnection>>();
  private readonly SESSION_TTL_MS = 10 * 60 * 1000;
  private readonly MAX_CACHED_CONNECTIONS = 50;

  constructor(private readonly urlGuard: McpUrlGuardService) {}

  /** 取得可用连接（命中缓存则复用，否则握手建立） */
  async getConnection(server: McpServerRuntimeConfig): Promise<McpConnection> {
    const key = this.cacheKey(server);

    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.connectedAt < this.SESSION_TTL_MS) {
      return cached;
    }
    if (cached) {
      await this.closeEntry(key, cached);
    }

    const inflight = this.pendingConnects.get(key);
    if (inflight) return inflight;

    const promise = this.createConnection(key, server).finally(() => {
      this.pendingConnects.delete(key);
    });
    this.pendingConnects.set(key, promise);
    return promise;
  }

  /** 让某个 Server 的缓存会话失效（配置变更 / 会话过期时调用） */
  async invalidate(server: McpServerRuntimeConfig): Promise<void> {
    const key = this.cacheKey(server);
    const cached = this.cache.get(key);
    if (cached) await this.closeEntry(key, cached);

    // 配置无关的兜底：按 id 清理（避免 credentials 变化导致 key 不一致时残留）
    if (server.id) {
      for (const [entryKey, entry] of this.cache) {
        if (entryKey.includes(`|${server.id}|`)) {
          await this.closeEntry(entryKey, entry);
        }
      }
    }
  }

  async invalidateById(serverId: string): Promise<void> {
    for (const [entryKey, entry] of this.cache) {
      if (entryKey.includes(`|${serverId}|`)) {
        await this.closeEntry(entryKey, entry);
      }
    }
  }

  /** 应用关闭时释放所有连接 */
  async closeAll(): Promise<void> {
    const entries = [...this.cache.entries()];
    for (const [key, entry] of entries) {
      await this.closeEntry(key, entry);
    }
  }

  /**
   * 执行一次带「会话失效自动重连」的操作。
   * 服务端重启后旧 Mcp-Session-Id 会返回 404，此时需要重新握手再试一次。
   */
  async withConnection<T>(
    server: McpServerRuntimeConfig,
    fn: (connection: McpConnection) => Promise<T>,
  ): Promise<T> {
    const connection = await this.getConnection(server);
    try {
      return await fn(connection);
    } catch (err) {
      if (!isSessionExpiredError(err)) throw err;

      this.logger.warn(
        `MCP Server ${server.id ?? server.serverUrl} 会话已失效，重新建立连接后重试`,
      );
      await this.invalidate(server);
      const retried = await this.getConnection(server);
      return fn(retried);
    }
  }

  // ===========================================================================
  // 内部实现
  // ===========================================================================

  private async createConnection(
    key: string,
    server: McpServerRuntimeConfig,
  ): Promise<McpConnection> {
    const transport = this.createTransport(server);
    try {
      const session = await transport.connect();
      const connection: McpConnection = {
        transport,
        session,
        connectedAt: Date.now(),
      };
      this.evictIfNeeded();
      this.cache.set(key, connection);
      this.logger.log(
        `MCP 已连接：${server.id ?? server.serverUrl} transport=${transport.kind} ` +
          `protocol=${session.protocolVersion} session=${session.sessionId ? 'yes' : 'no'}`,
      );
      return connection;
    } catch (err) {
      await transport.close().catch(() => undefined);
      throw err instanceof McpProtocolError
        ? err
        : new McpProtocolError(
            `MCP 连接失败：${err instanceof Error ? err.message : String(err)}`,
          );
    }
  }

  private createTransport(server: McpServerRuntimeConfig): McpTransport {
    const context = {
      config: server,
      limits: DEFAULT_TRANSPORT_LIMITS,
      validateUrl: (url: string) => this.urlGuard.assertSafeUrl(url),
    };
    // 三种传输的连接流程 / 消息分帧 / 会话管理完全不同，必须走各自实现：
    //   STDIO           → spawn 子进程，换行分隔 JSON，进程即会话
    //   SSE             → 旧版 HTTP + 长连接事件流
    //   STREAMABLE_HTTP → 单端点 POST，响应可能是 json 也可能是 sse
    if (server.transport === 'STDIO') {
      return new StdioTransport(context);
    }
    return server.transport === 'SSE'
      ? new SseTransport(context)
      : new StreamableHttpTransport(context);
  }

  private async closeEntry(key: string, entry: McpConnection): Promise<void> {
    this.cache.delete(key);
    await entry.transport.close().catch(() => undefined);
  }

  private evictIfNeeded(): void {
    if (this.cache.size < this.MAX_CACHED_CONNECTIONS) return;
    const [oldestKey] = this.cache.keys();
    if (!oldestKey) return;
    const entry = this.cache.get(oldestKey);
    if (entry) void this.closeEntry(oldestKey, entry);
  }

  /**
   * 缓存 key 由连接语义决定：Server 身份 + 传输方式 + 地址/命令 + 认证方式 + 凭据指纹。
   * 任一项变化都会得到新 key，从而不会复用错误会话。
   *
   * STDIO 的「地址」是 command + args（同一台机器上 `npx -y a` 与 `npx -y b` 是两个
   * 完全不同的进程），所以必须把 args 也纳入指纹，否则会错误复用别人的子进程。
   */
  private cacheKey(server: McpServerRuntimeConfig): string {
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          id: server.id ?? '',
          transport: server.transport,
          serverUrl: server.serverUrl,
          command: server.command ?? null,
          args: server.args ?? null,
          authType: server.authType,
          credentials: server.credentials ?? null,
        }),
      )
      .digest('hex')
      .slice(0, 16);
    return `${server.transport}|${server.id ?? 'adhoc'}|${fingerprint}`;
  }
}
