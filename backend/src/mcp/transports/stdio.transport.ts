import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import {
  McpProtocolError,
  McpTransportError,
  MCP_CLIENT_INFO,
  MCP_LATEST_PROTOCOL_VERSION,
  MCP_MAX_TOOL_PAGES,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  type JsonRpcResponse,
  type McpInitializeResult,
  type McpTool,
  type McpToolCallResult,
  type McpToolListResult,
  type McpTransportSession,
} from '../types/mcp.types';
import type {
  McpTransport,
  McpTransportContext,
} from './mcp-transport.interface';

/**
 * 子进程环境变量白名单。
 *
 * **绝不能用 `{ ...process.env }`** —— 后端 .env 里有 JWT_SECRET、
 * LLM_CONFIG_ENCRYPTION_KEY、数据库密码、对象存储密钥，一旦被子进程继承，
 * 任何一个第三方 MCP Server（本质是任意代码）都能直接读走。
 * 这里只放「跑起来必需的运行时变量」+ 代理变量。
 */
const ENV_ALLOWLIST = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'WINDIR',
  'ComSpec',
  'COMSPEC',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERNAME',
  'USER',
  'LOGNAME',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  'npm_config_cache',
  'npm_config_prefix',
  'NPM_CONFIG_CACHE',
  'NPM_CONFIG_PREFIX',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

/** 环境变量名必须是合法标识符，防止注入 NODE_OPTIONS 之类的危险项 */
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** stderr 只保留尾部若干字节用于报错，避免长时间运行的进程吃满内存 */
const STDERR_TAIL_BYTES = 4 * 1024;

/**
 * STDIO 传输 —— 本地子进程 + 标准输入输出。
 *
 * 与远程传输的关键差异（这也是不能复用 HTTP 实现的原因）：
 *  1. **没有 URL**，靠 spawn 一个进程通信，进程即连接；
 *  2. 消息分帧不是 HTTP 响应体，而是 **换行分隔的单行 JSON**（MCP stdio 规范），
 *     因此必须自己维护缓冲区、按 `\n` 切分、处理半行；
 *  3. 会话就是进程生命周期：进程退出 = 连接断开，所有挂起请求都要 reject；
 *  4. 关闭时要**杀进程树**（npx 会再 fork 出 node，只 kill 父进程会留下孤儿）。
 *
 * 安全边界：命令白名单由 McpService 在写入前校验；这里额外做三件事 ——
 *   - 环境变量白名单（不继承后端 .env 的密钥）；
 *   - 不走 shell（除 Windows 的 .cmd/.bat 需要 cmd.exe 包装外），避免参数注入；
 *   - Windows 下拒绝无法安全转义的参数（CR/LF/^）。
 */
export class StdioTransport implements McpTransport {
  readonly kind = 'STDIO' as const;

  private readonly command: string;
  private readonly args: string[];
  private readonly extraEnv: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly connectTimeoutMs: number;

  private child?: ChildProcessWithoutNullStreams;
  private stdoutBuffer = '';
  private stderrTail = '';
  private exitInfo?: { code: number | null; signal: string | null };
  private nextId = 1;
  private protocolVersion?: string;
  private closed = false;

  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(context: McpTransportContext) {
    this.command = (context.config.command ?? '').trim();
    this.args = Array.isArray(context.config.args)
      ? context.config.args.map((a) => String(a))
      : [];
    this.extraEnv = context.config.env ?? {};
    this.timeoutMs = context.limits.timeoutMs;
    // 首次 `npx -y xxx` 要下载包，30s 经常不够，单独给一个更宽的握手预算
    this.connectTimeoutMs = Number(
      process.env.MCP_STDIO_CONNECT_TIMEOUT_MS ?? 120_000,
    );
  }

  async connect(): Promise<McpTransportSession> {
    if (!this.command) {
      throw new McpTransportError('stdio 传输缺少 command');
    }

    this.spawnChild();

    const result = (await this.sendRequest(
      'initialize',
      {
        protocolVersion: MCP_LATEST_PROTOCOL_VERSION,
        capabilities: { roots: { listChanged: false } },
        clientInfo: MCP_CLIENT_INFO,
      },
      this.connectTimeoutMs,
    )) as McpInitializeResult;

    if (!result || typeof result !== 'object') {
      throw new McpProtocolError('MCP initialize 返回体格式不正确');
    }

    const negotiated = String(result.protocolVersion ?? '');
    if (!negotiated) {
      throw new McpProtocolError('MCP Server 未返回 protocolVersion');
    }
    if (!(MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(negotiated)) {
      throw new McpProtocolError(
        `MCP Server 返回了不支持的协议版本 ${negotiated}，客户端支持：${MCP_SUPPORTED_PROTOCOL_VERSIONS.join(' / ')}`,
      );
    }
    this.protocolVersion = negotiated;

    this.sendNotification('notifications/initialized');

    return {
      protocolVersion: negotiated,
      // stdio 没有 Mcp-Session-Id，会话由进程本身承载
      sessionId: undefined,
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

    this.rejectAllPending(new McpTransportError('stdio 连接已关闭'));

    const child = this.child;
    this.child = undefined;
    if (!child || child.killed || child.exitCode !== null) return;

    // 先礼后兵：SIGTERM → 2s 后 SIGKILL
    try {
      this.killTree(child, false);
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          this.killTree(child, true);
        } catch {
          /* ignore */
        }
        resolve();
      }, 2_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // ===========================================================================
  // 内部：进程与消息收发
  // ===========================================================================

  private spawnChild(): void {
    const target = resolveSpawnTarget(this.command, this.args);
    const env = buildChildEnv(this.extraEnv);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(target.file, target.args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // 只有在「必须用 cmd.exe 包一层」时才开启 verbatim，避免参数被 Node 二次转义
        windowsVerbatimArguments: target.viaCmd,
        shell: false,
      });
    } catch (err) {
      throw new McpTransportError(
        `无法启动 stdio 进程「${this.command}」：${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.child = child;

    child.on('error', (err) => {
      this.exitInfo = { code: null, signal: null };
      this.rejectAllPending(
        new McpTransportError(
          `stdio 进程启动失败：${err.message}（请确认命令已安装且在白名单内）`,
        ),
      );
    });

    child.on('exit', (code, signal) => {
      this.exitInfo = { code, signal };
      this.rejectAllPending(
        new McpTransportError(
          `stdio 进程已退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）${this.stderrSuffix()}`,
        ),
      );
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });

    // stdin 关闭时（EPIPE）不要让它变成未捕获异常
    child.stdin.on('error', () => undefined);
  }

  /** 按换行切分 JSON-RPC 消息；半行留在缓冲区等下一块数据 */
  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;

    let index = this.stdoutBuffer.indexOf('\n');
    while (index >= 0) {
      const line = this.stdoutBuffer.slice(0, index).replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      this.handleLine(line);
      index = this.stdoutBuffer.indexOf('\n');
    }

    // 防御：服务端若只输出不带换行的巨型内容，避免无限增长
    if (this.stdoutBuffer.length > 8 * 1024 * 1024) {
      this.stdoutBuffer = '';
      this.stderrTail = (
        this.stderrTail + '\n[客户端] stdout 单行超过 8MB，已丢弃'
      ).slice(-STDERR_TAIL_BYTES);
    }
  }

  private handleLine(rawLine: string): void {
    const line = rawLine.trim();
    if (!line) return;

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // 不少实现会把日志打到 stdout（协议上不允许），这里容忍并留痕
      this.stderrTail = (this.stderrTail + `\n[stdout 非 JSON] ${line.slice(0, 200)}`).slice(
        -STDERR_TAIL_BYTES,
      );
      return;
    }

    if (!message || typeof message !== 'object') return;
    const msg = message as Record<string, unknown>;

    // 服务端发来的请求（sampling / roots / ping 等）：我们不支持，回 method not found
    if (msg.id !== undefined && typeof msg.method === 'string') {
      this.writeLine({
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code: -32601,
          message: `客户端不支持 ${String(msg.method)}`,
        },
      });
      return;
    }

    // 通知（无 id）忽略
    if (msg.id === undefined || msg.id === null) return;

    const id = Number(msg.id);
    const entry = this.pending.get(id);
    if (!entry) return;

    this.pending.delete(id);
    clearTimeout(entry.timer);

    if (msg.error) {
      const err = msg.error as { message?: string; code?: number; data?: unknown };
      entry.reject(
        new McpProtocolError(
          `MCP 请求失败：${err.message ?? '未知错误'}（code ${err.code ?? 'n/a'}）`,
          { code: err.code, data: err.data },
        ),
      );
      return;
    }

    entry.resolve(msg.result);
  }

  private sendRequest(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = this.timeoutMs,
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new McpTransportError('stdio 连接已关闭'));
    }
    if (this.exitInfo) {
      return Promise.reject(
        new McpTransportError(
          `stdio 进程已退出（code=${this.exitInfo.code ?? 'null'}）${this.stderrSuffix()}`,
        ),
      );
    }

    const id = this.nextId++;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new McpTransportError(
            `stdio ${method} 超时（${timeoutMs}ms）${this.stderrSuffix()}`,
          ),
        );
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      try {
        this.writeLine({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new McpTransportError(String(err)));
      }
    });
  }

  private sendNotification(method: string): void {
    if (this.closed || this.exitInfo) return;
    try {
      this.writeLine({ jsonrpc: '2.0', method });
    } catch {
      /* 通知失败不影响握手结果 */
    }
  }

  private writeLine(payload: Record<string, unknown>): void {
    const child = this.child;
    if (!child || !child.stdin.writable) {
      throw new McpTransportError(
        `stdio 进程不可写（可能已退出）${this.stderrSuffix()}`,
      );
    }
    // MCP stdio 规范：一条消息一行 JSON，消息内不能出现裸换行
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private rejectAllPending(err: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(err);
    }
  }

  private stderrSuffix(): string {
    const tail = this.stderrTail.trim();
    if (!tail) return '';
    return `\n进程输出：${tail.slice(-600)}`;
  }

  /** 杀掉整个进程树：Windows 用 taskkill /T，POSIX 用进程组 */
  private killTree(child: ChildProcessWithoutNullStreams, force: boolean): void {
    if (child.pid === undefined) return;

    if (process.platform === 'win32') {
      const args = ['/pid', String(child.pid), '/T'];
      if (force) args.push('/F');
      const killer = spawn('taskkill', args, { stdio: 'ignore' });
      killer.on('error', () => undefined);
      return;
    }

    try {
      // 子进程以 detached 方式启动时才有独立进程组；这里退化用 kill
      child.kill(force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      /* ignore */
    }
  }
}

// ===========================================================================
// 子进程启动目标解析
// ===========================================================================

interface SpawnTarget {
  file: string;
  args: string[];
  /** 是否通过 cmd.exe 包装（仅 Windows 的 .cmd / .bat 需要） */
  viaCmd: boolean;
}

/**
 * 解析要执行的最终文件。
 *
 * Windows 的坑：Node 的 `spawn(..., { shell: false })` **不能直接执行 .cmd/.bat**，
 * 而 `npx` / `uvx` / `pnpm` 全都是 .cmd。用 `shell: true` 又会让参数被拼进命令行、
 * 失去转义保护。所以这里自己按 PATH 找真实文件：.exe/.com 直接执行，
 * .cmd/.bat 用 `cmd.exe /d /s /c` 包一层，并对每个参数做严格转义。
 */
function resolveSpawnTarget(command: string, args: string[]): SpawnTarget {
  if (process.platform !== 'win32') {
    return { file: command, args, viaCmd: false };
  }

  const isExplicitPath = /[\\/]/.test(command);
  const candidates: string[] = [];

  if (isExplicitPath) {
    candidates.push(command);
  } else {
    const pathValue = process.env.PATH ?? process.env.Path ?? '';
    const exts = ['.exe', '.cmd', '.bat', '.com'];
    for (const dir of pathValue.split(delimiter).filter(Boolean)) {
      for (const ext of exts) {
        candidates.push(join(dir, `${command}${ext}`));
      }
      candidates.push(join(dir, command));
    }
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;

    if (/\.(cmd|bat)$/i.test(candidate)) {
      const comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
      const quoted = [candidate, ...args].map(quoteCmdArg).join(' ');
      // /d 跳过 AutoRun，/s 让 cmd 用「首尾引号」规则解析整串
      return { file: comspec, args: ['/d', '/s', '/c', `"${quoted}"`], viaCmd: true };
    }

    return { file: candidate, args, viaCmd: false };
  }

  // 找不到就原样交给 spawn，让它抛 ENOENT，错误信息里带上命令名更好排查
  return { file: command, args, viaCmd: false };
}

/**
 * 给 cmd.exe 包装时用的参数转义。
 *
 * 只需要保证「参数原样传给目标程序」：含空白或特殊字符时加双引号，
 * 双引号本身用反斜杠转义。CR/LF/^ 无法安全表达，直接拒绝。
 */
function quoteCmdArg(arg: string): string {
  const value = String(arg);
  if (/[\r\n^]/.test(value)) {
    throw new McpTransportError(
      `stdio 参数包含无法安全转义的字符（CR / LF / ^）：${JSON.stringify(value.slice(0, 60))}`,
    );
  }
  if (value === '') return '""';
  if (!/[\s"&|<>()]/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

/** 白名单环境 + 用户自定义 env（自定义项优先，但 key 必须是合法标识符） */
function buildChildEnv(
  extra: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === 'string') env[key] = value;
  }

  for (const [key, raw] of Object.entries(extra ?? {})) {
    if (!ENV_KEY_PATTERN.test(key)) continue;
    if (raw === undefined || raw === null) continue;
    env[key] = String(raw);
  }

  return env;
}

/** 供上层复用的错误类型（保持与远程传输一致的错误语义） */
export type { JsonRpcResponse };
