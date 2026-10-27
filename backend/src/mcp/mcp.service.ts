import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EncryptionService } from '../common/crypto/encryption.service';
import { CreateMcpServerDto } from './dto/create-mcp-server.dto';
import { UpdateMcpServerDto } from './dto/update-mcp-server.dto';
import { McpConnectionService } from './mcp-connection.service';
import { McpToolService } from './mcp-tool.service';
import { McpUrlGuardService } from './mcp-url-guard.service';
import type {
  McpAuthType,
  McpServerRuntimeConfig,
  McpTool,
  McpTransportKind,
} from './types/mcp.types';
import { MCP_TRANSPORT_KINDS, stdioEndpointLabel } from './types/mcp.types';

/**
 * 数据库查询字段：含 credentials（仅用于生成掩码预览，返回前端前会被剥离）。
 */
const mcpSelection = {
  id: true,
  ownerId: true,
  name: true,
  description: true,
  transport: true,
  serverUrl: true,
  command: true,
  args: true,
  envCipher: true,
  authType: true,
  status: true,
  lastError: true,
  availableTools: true,
  protocolVersion: true,
  serverName: true,
  serverVersion: true,
  lastConnectedAt: true,
  createdAt: true,
  updatedAt: true,
  credentials: true,
} as const;

/** 运行时用的完整配置（含解密后的凭据，仅在服务端内部流转） */
export interface McpServerRuntime extends McpServerRuntimeConfig {
  id: string;
  name: string;
  credentials: { apiKey?: string; bearerToken?: string };
}

/** 加密后的凭据存储格式 */
interface EncryptedCredentials {
  v: 2;
  cipher: string;
}

/**
 * MCP Server 配置管理 + 业务流程编排。
 *
 * 本服务不直接与 MCP Server 通信：
 *  - 协议通信 → transports/*（Streamable HTTP / SSE）
 *  - 会话生命周期 → McpConnectionService
 *  - 工具发现与调用 → McpToolService
 *  - 目标地址安全校验 → McpUrlGuardService
 *
 * 这里只负责：配置 CRUD、凭据加密、连接状态落库、对外接口编排。
 */
@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly urlGuard: McpUrlGuardService,
    private readonly connections: McpConnectionService,
    private readonly toolService: McpToolService,
  ) {}

  // ===========================================================================
  // CRUD
  // ===========================================================================

  /** 创建 MCP Server（当前用户作为 owner） */
  async create(userId: string, dto: CreateMcpServerDto) {
    const transport = this.resolveTransport(dto.transport);
    const target = this.resolveTarget(transport, dto);

    // 认证只对远程传输有意义；stdio 的密钥走 env
    const authType =
      transport === 'STDIO' ? 'NONE' : ((dto.authType ?? 'NONE') as McpAuthType);
    if (transport !== 'STDIO') this.assertCredentialsProvided(authType, dto);

    const server = await this.prisma.mcpServer.create({
      data: {
        ownerId: userId,
        name: dto.name,
        description: dto.description,
        transport,
        serverUrl: target.serverUrl,
        command: target.command,
        args: target.args as never,
        envCipher: target.envCipher as never,
        authType,
        credentials:
          transport === 'STDIO'
            ? undefined
            : (this.encryptCredentials(dto) as never),
        status: 'DISCONNECTED',
      },
      select: mcpSelection,
    });

    return this.toPublicServer(server);
  }

  /**
   * 创建「凭据待补充」的 MCP Server —— 供平台助理调用。
   *
   * 为什么单独开一个入口，而不是复用 create()：
   *   - 平台助理**不接收密钥**。聊天消息正文（ChatMessage.content）和审计日志
   *     （PlatformOperationLog.params）都会把入参原样落库，密钥一旦从聊天里传进来
   *     就等于明文写进两张表，事后无法追溯清理；
   *   - 因此这里跳过 create() 里的 assertCredentialsProvided 校验：认证方式仍按用户
   *     意图记录，credentials 留空、status=DISCONNECTED，等用户到 /mcp 页面补填密钥
   *     后再走 PUT /mcp-servers/:id + POST /:id/test。
   *
   * 安全边界没有被削弱：URL 形态校验（SSRF）与 create() 完全一致；
   * 未配置凭据的 Server 在运行时拿不到任何认证头，调用必然失败，不存在"绕过认证"。
   */
  async createPendingCredentials(
    userId: string,
    dto: {
      name: string;
      description?: string;
      transport?: string;
      serverUrl: string;
      authType?: string;
    },
  ) {
    this.urlGuard.assertSafeUrlShape(dto.serverUrl);

    // 平台助理只走远程传输：stdio 等于「让模型在服务器上执行命令」，
    // 不开放给自然语言入口（需要用户在 /mcp 页面显式配置）。
    const transport = this.resolveTransport(dto.transport);
    if (transport === 'STDIO') {
      throw new BadRequestException(
        '平台助理不能创建 stdio（本地进程）类型的 MCP Server，请到 /mcp 页面手动配置',
      );
    }

    const server = await this.prisma.mcpServer.create({
      data: {
        ownerId: userId,
        name: dto.name,
        description: dto.description,
        transport,
        serverUrl: dto.serverUrl,
        authType: dto.authType ?? 'NONE',
        // 刻意不写 credentials —— 凭据只能由用户在页面上填写
        status: 'DISCONNECTED',
      },
      select: mcpSelection,
    });

    return this.toPublicServer(server);
  }

  /** 获取当前用户的全部 MCP Servers */
  async findAll(userId: string) {
    const servers = await this.prisma.mcpServer.findMany({
      where: { ownerId: userId },
      orderBy: { createdAt: 'desc' },
      select: mcpSelection,
    });
    return servers.map((s) => this.toPublicServer(s));
  }

  /**
   * 传输能力（供前端渲染表单，不含敏感信息）。
   *
   * stdio 默认关闭，前端据此决定要不要显示「本地进程」选项 ——
   * 显示出来但点了报 400 的体验很差，而且会把「服务器能执行命令」这件事
   * 暴露给不该看到的人。
   */
  getCapabilities() {
    const stdioEnabled = process.env.MCP_STDIO_ENABLED === 'true';
    const allowedCommands = (
      process.env.MCP_STDIO_ALLOWED_COMMANDS ??
      'npx,node,uvx,python,python3,deno,bun'
    )
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    return {
      transports: stdioEnabled
        ? ['STREAMABLE_HTTP', 'SSE', 'STDIO']
        : ['STREAMABLE_HTTP', 'SSE'],
      stdio: {
        enabled: stdioEnabled,
        allowedCommands: stdioEnabled ? allowedCommands : [],
      },
    };
  }

  /**
   * 按 ID 批量获取运行时配置（工作流 / Agent 执行时用，无需 owner 校验）。
   * 凭据在这里解密，只允许服务端内部使用，绝不能直接返回给前端。
   */
  async findRuntimeConfigs(ids: string[]): Promise<McpServerRuntime[]> {
    if (!ids || ids.length === 0) return [];

    const servers = await this.prisma.mcpServer.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        name: true,
        transport: true,
        serverUrl: true,
        command: true,
        args: true,
        envCipher: true,
        authType: true,
        credentials: true,
        availableTools: true,
      },
    });

    return servers.map((s) => ({
      id: s.id,
      name: s.name,
      transport: s.transport,
      serverUrl: this.endpointOf(s),
      command: s.command ?? undefined,
      args: Array.isArray(s.args) ? (s.args as string[]) : undefined,
      env: this.decryptEnv(s.envCipher),
      authType: s.authType,
      credentials: this.decryptCredentials(s.credentials),
      cachedTools: Array.isArray(s.availableTools)
        ? (s.availableTools as unknown as McpTool[])
        : undefined,
    }));
  }

  /** 兼容旧调用名（工作流 LLM 节点曾用 findByIds） */
  findByIds(ids: string[]) {
    return this.findRuntimeConfigs(ids);
  }

  /** 获取单个 MCP Server（owner 校验） */
  async findOne(userId: string, id: string) {
    const server = await this.prisma.mcpServer.findUnique({
      where: { id },
      select: mcpSelection,
    });
    if (!server) throw new NotFoundException('MCP Server not found');
    this.assertOwner(userId, server);
    return this.toPublicServer(server);
  }

  /** 更新 MCP Server */
  async update(userId: string, id: string, dto: UpdateMcpServerDto) {
    const existing = await this.assertOwnerExists(userId, id);

    const nextTransport = dto.transport
      ? this.resolveTransport(dto.transport)
      : (existing.transport as McpTransportKind);

    // 目标形态校验：改传输方式时，必须保证新形态的必填项齐备
    const target = this.resolveTarget(
      nextTransport,
      {
        serverUrl: dto.serverUrl ?? existing.serverUrl ?? undefined,
        command: dto.command ?? existing.command ?? undefined,
        args: dto.args ?? (Array.isArray(existing.args) ? (existing.args as string[]) : undefined),
        env: dto.env,
      },
      { isUpdate: true },
    );

    const nextAuthType = (
      nextTransport === 'STDIO' ? 'NONE' : (dto.authType ?? existing.authType)
    ) as McpAuthType;
    if (nextTransport !== 'STDIO') {
      this.assertCredentialsProvided(nextAuthType, dto, true);
    }

    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.transport !== undefined) data.transport = nextTransport;

    data.serverUrl = target.serverUrl;
    data.command = target.command;
    if (target.args !== undefined || dto.transport !== undefined || dto.args !== undefined) {
      data.args = target.args as never;
    }
    if (target.envCipher !== undefined) data.envCipher = target.envCipher as never;
    if (nextTransport === 'STDIO') data.authType = 'NONE';
    else if (dto.authType !== undefined) data.authType = nextAuthType;

    // 凭据更新：与现有解密后的凭据合并后重新加密（stdio 不用凭据）
    if (
      nextTransport !== 'STDIO' &&
      (dto.apiKey !== undefined ||
        dto.bearerToken !== undefined ||
        dto.authType !== undefined)
    ) {
      const merged = this.decryptCredentials(existing.credentials);
      if (dto.apiKey !== undefined) merged.apiKey = dto.apiKey || undefined;
      if (dto.bearerToken !== undefined) {
        merged.bearerToken = dto.bearerToken || undefined;
      }
      data.credentials = this.encryptPlainCredentials(merged);
    }

    // 连接相关字段变更 → 旧会话与工具缓存都不可信，重置
    const connectionChanged =
      dto.serverUrl !== undefined ||
      dto.authType !== undefined ||
      dto.transport !== undefined ||
      dto.apiKey !== undefined ||
      dto.bearerToken !== undefined ||
      dto.command !== undefined ||
      dto.args !== undefined ||
      dto.env !== undefined;

    if (connectionChanged) {
      data.status = 'DISCONNECTED';
      data.lastError = null;
      data.availableTools = null;
      data.protocolVersion = null;
      data.serverName = null;
      data.serverVersion = null;
      data.lastConnectedAt = null;
      await this.connections.invalidateById(id);
    }

    const server = await this.prisma.mcpServer.update({
      where: { id },
      data: data as never,
      select: mcpSelection,
    });
    return this.toPublicServer(server);
  }

  /** 删除 MCP Server */
  async remove(userId: string, id: string) {
    await this.assertOwnerExists(userId, id);
    await this.connections.invalidateById(id);
    const server = await this.prisma.mcpServer.delete({
      where: { id },
      select: mcpSelection,
    });
    return this.toPublicServer(server);
  }

  // ===========================================================================
  // 连接测试 / 工具发现
  // ===========================================================================

  /**
   * 测试连接：完成 initialize 握手 + tools/list，并把结果落库。
   * 返回统一的成功/失败结构，供前端展示「连接状态 / 可用工具 / 最后连接时间」。
   */
  async testConnection(userId: string, id: string) {
    const server = await this.assertOwnerExists(userId, id);
    return this.runConnectionTest(id, server);
  }

  /** 刷新工具列表（与连接测试同一条链路，语义更明确） */
  async refreshTools(userId: string, id: string) {
    const server = await this.assertOwnerExists(userId, id);
    return this.runConnectionTest(id, server);
  }

  private async runConnectionTest(
    id: string,
    server: {
      name: string;
      transport: string;
      serverUrl: string | null;
      command: string | null;
      args: unknown;
      envCipher: unknown;
      authType: string;
      credentials: unknown;
    },
  ) {
    // stdio 会真的 spawn 进程：开关关掉之后，历史配置也不允许再启动
    if (server.transport === 'STDIO') {
      this.assertStdioEnabled();
      this.assertCommandAllowed(server.command ?? '');
    }

    const runtime: McpServerRuntime = this.toRuntime(id, server);

    try {
      // 强制重新握手，确保「测试连接」拿到的是真实状态
      await this.connections.invalidateById(id);
      const connection = await this.connections.getConnection(runtime);
      const tools = await connection.transport.listTools();

      const connectedAt = new Date();
      await this.prisma.mcpServer.update({
        where: { id },
        data: {
          status: 'CONNECTED',
          lastError: null,
          availableTools: tools as never,
          protocolVersion: connection.session.protocolVersion,
          serverName: connection.session.serverInfo?.name ?? null,
          serverVersion: connection.session.serverInfo?.version ?? null,
          lastConnectedAt: connectedAt,
        },
      });

      return {
        success: true,
        status: 'CONNECTED' as const,
        transport: runtime.transport,
        protocolVersion: connection.session.protocolVersion,
        serverInfo: connection.session.serverInfo ?? null,
        instructions: connection.session.instructions ?? null,
        tools,
        lastConnectedAt: connectedAt.toISOString(),
        message: `连接成功，发现 ${tools.length} 个可用工具`,
      };
    } catch (err) {
      const errorMsg = this.toErrorMessage(err);
      await this.prisma.mcpServer.update({
        where: { id },
        data: {
          status: 'ERROR',
          lastError: errorMsg,
          availableTools: null as never,
          lastConnectedAt: null,
        },
      });

      return {
        success: false,
        status: 'ERROR' as const,
        transport: runtime.transport,
        tools: [] as McpTool[],
        message: errorMsg,
      };
    }
  }

  // ===========================================================================
  // 工具调用
  // ===========================================================================

  /**
   * 按 Server 配置调用工具（内部/工作流链路使用）。
   * 返回模型可读的文本结果。
   */
  async callTool(
    server: McpServerRuntimeConfig,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const outcome = await this.toolService.callToolStrict(
      server,
      toolName,
      args,
    );
    return outcome.text;
  }

  /** 调试用：校验 owner 后调用某个工具，返回完整结果 */
  async callToolForUser(
    userId: string,
    id: string,
    toolName: string,
    args: Record<string, unknown>,
  ) {
    const server = await this.assertOwnerExists(userId, id);
    const runtime = this.toRuntime(id, server);

    const started = Date.now();
    const outcome = await this.toolService.callToolStrict(
      runtime,
      toolName,
      args ?? {},
    );

    return {
      success: !outcome.isError,
      toolName,
      durationMs: Date.now() - started,
      content: outcome.text,
      structuredContent: outcome.result.structuredContent ?? null,
      isError: outcome.isError,
    };
  }

  /** 取某个 Server 当前可用的工具列表（实时发现，不落库） */
  async listToolsLive(userId: string, id: string) {
    const server = await this.assertOwnerExists(userId, id);
    const runtime = this.toRuntime(id, server);
    return this.toolService.listTools(runtime);
  }

  // ===========================================================================
  // 凭据处理
  // ===========================================================================

  /** 组装加密后的 credentials 字段 */
  private encryptCredentials(dto: CreateMcpServerDto): EncryptedCredentials {
    return this.encryptPlainCredentials({
      apiKey: dto.apiKey || undefined,
      bearerToken: dto.bearerToken || undefined,
    });
  }

  private encryptPlainCredentials(plain: {
    apiKey?: string;
    bearerToken?: string;
  }): EncryptedCredentials {
    const payload: Record<string, string> = {};
    if (plain.apiKey) payload.apiKey = plain.apiKey;
    if (plain.bearerToken) payload.bearerToken = plain.bearerToken;
    return {
      v: 2,
      cipher: this.encryption.encrypt(JSON.stringify(payload)),
    };
  }

  /**
   * 解密凭据。
   * 兼容历史明文数据（旧版本直接把 { apiKey, bearerToken } 存进 credentials）。
   */
  private decryptCredentials(raw: unknown): {
    apiKey?: string;
    bearerToken?: string;
  } {
    if (!raw || typeof raw !== 'object') return {};
    const obj = raw as Record<string, unknown>;

    if (obj.v === 2 && typeof obj.cipher === 'string') {
      try {
        const decrypted = this.encryption.decrypt(obj.cipher);
        const parsed = JSON.parse(decrypted) as Record<string, unknown>;
        return {
          apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : undefined,
          bearerToken:
            typeof parsed.bearerToken === 'string'
              ? parsed.bearerToken
              : undefined,
        };
      } catch (err) {
        this.logger.error(
          `MCP 凭据解密失败（可能是加密密钥变更）：${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return {};
      }
    }

    // 历史明文格式
    return {
      apiKey: typeof obj.apiKey === 'string' ? obj.apiKey : undefined,
      bearerToken:
        typeof obj.bearerToken === 'string' ? obj.bearerToken : undefined,
    };
  }

  /**
   * 把数据库行转成对前端安全的对象：
   * 剥离 credentials / envCipher，只保留「是否已配置凭据 + 掩码预览 + env 键名」。
   *
   * env 值一律不返回 —— 它可能装着 API Key，前端只需要知道「配了哪几个键」。
   */
  private toPublicServer<
    T extends { credentials?: unknown; envCipher?: unknown },
  >(server: T) {
    const { credentials, envCipher, ...rest } = server;
    const creds = this.decryptCredentials(credentials);
    const secret = creds.bearerToken ?? creds.apiKey ?? null;
    const env = this.decryptEnv(envCipher);

    return {
      ...rest,
      hasCredentials: Boolean(secret),
      credentialPreview: secret ? this.encryption.maskApiKey(secret) : null,
      envKeys: Object.keys(env),
    };
  }

  // ===========================================================================
  // 传输形态解析与校验
  // ===========================================================================

  private resolveTransport(raw?: string): McpTransportKind {
    const transport = String(raw ?? 'STREAMABLE_HTTP').toUpperCase();
    if (!MCP_TRANSPORT_KINDS.includes(transport as McpTransportKind)) {
      throw new BadRequestException(
        `不支持的 transport「${raw}」，可选：${MCP_TRANSPORT_KINDS.join(' / ')}`,
      );
    }
    return transport as McpTransportKind;
  }

  /**
   * 校验并归一化「连接目标」：远程要 URL，STDIO 要 command。
   *
   * 返回的字段会直接写库；远程形态会把 command/args/env 清空，STDIO 会把 serverUrl 清空，
   * 避免切换传输方式后残留上一套配置。
   */
  private resolveTarget(
    transport: McpTransportKind,
    dto: {
      serverUrl?: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    },
    options: { isUpdate?: boolean } = {},
  ): {
    serverUrl: string | null;
    command: string | null;
    args?: string[] | null;
    envCipher?: EncryptedCredentials | null;
  } {
    if (transport === 'STDIO') {
      this.assertStdioEnabled();

      const command = (dto.command ?? '').trim();
      if (!command) {
        throw new BadRequestException('STDIO（本地进程）传输必须提供 command');
      }
      this.assertCommandAllowed(command);

      const args = Array.isArray(dto.args)
        ? dto.args.map((a) => String(a))
        : undefined;

      return {
        serverUrl: null,
        command,
        args: args ?? (options.isUpdate ? undefined : null),
        // env 只在显式传入时更新，避免「改个名字把环境变量清空」
        envCipher:
          dto.env !== undefined
            ? this.encryptEnv(dto.env)
            : options.isUpdate
              ? undefined
              : null,
      };
    }

    const serverUrl = (dto.serverUrl ?? '').trim();
    if (!serverUrl) {
      throw new BadRequestException(
        `${transport} 传输必须提供 serverUrl（本地进程请把 transport 设为 STDIO）`,
      );
    }
    this.urlGuard.assertSafeUrlShape(serverUrl);

    return { serverUrl, command: null, args: null, envCipher: null };
  }

  /**
   * STDIO 总开关。
   *
   * stdio 的本质是「在服务器上执行任意命令」，比 SSRF 严重一个量级：
   * 一个被攻破的普通账号就能拿到后端进程的运行权限。因此默认关闭，
   * 只有显式设置 MCP_STDIO_ENABLED=true 才开放（自托管场景由部署者承担风险）。
   */
  private assertStdioEnabled(): void {
    if (process.env.MCP_STDIO_ENABLED === 'true') return;
    throw new BadRequestException(
      'stdio（本地进程）传输未启用：它会在服务器上执行任意命令，默认关闭。' +
        '确认只在可信环境使用后，在 backend/.env 设置 MCP_STDIO_ENABLED=true 并重启后端。',
    );
  }

  /**
   * 可执行文件白名单。
   *
   * 只做「命令名」级别限制（不限制参数），目的是挡住 `curl` / `bash -c` / `powershell`
   * 这类一眼就能执行任意载荷的入口；真正的隔离要靠容器。
   */
  private assertCommandAllowed(command: string): void {
    const value = command.trim();
    if (!value) {
      throw new BadRequestException('command 不能为空');
    }
    if (/[\r\n]/.test(value)) {
      throw new BadRequestException('command 不能包含换行');
    }

    const allowed = (
      process.env.MCP_STDIO_ALLOWED_COMMANDS ??
      'npx,node,uvx,python,python3,deno,bun'
    )
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    // 取文件名并去掉扩展名：C:\Program Files\nodejs\npx.cmd → npx
    const base = (value.split(/[\\/]/).pop() ?? '')
      .toLowerCase()
      .replace(/\.(exe|cmd|bat|com)$/, '');

    if (!allowed.includes(base)) {
      throw new BadRequestException(
        `命令「${command}」不在白名单内。当前允许：${allowed.join(' / ')}` +
          '（可通过 MCP_STDIO_ALLOWED_COMMANDS 调整）',
      );
    }
  }

  /** 加密 stdio 环境变量（可能含 API Key，与 credentials 同样的加密格式） */
  private encryptEnv(env: Record<string, string>): EncryptedCredentials {
    const plain: Record<string, string> = {};
    for (const [key, value] of Object.entries(env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new BadRequestException(`环境变量名不合法：${key}`);
      }
      if (value === undefined || value === null) continue;
      plain[key] = String(value);
    }
    if (Object.keys(plain).length > 50) {
      throw new BadRequestException('环境变量最多 50 个');
    }
    return { v: 2, cipher: this.encryption.encrypt(JSON.stringify(plain)) };
  }

  private decryptEnv(raw: unknown): Record<string, string> {
    if (!raw || typeof raw !== 'object') return {};
    const obj = raw as Record<string, unknown>;
    if (obj.v === 2 && typeof obj.cipher === 'string') {
      try {
        const parsed: unknown = JSON.parse(this.encryption.decrypt(obj.cipher));
        if (parsed && typeof parsed === 'object') {
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(
            parsed as Record<string, unknown>,
          )) {
            if (typeof v === 'string') out[k] = v;
          }
          return out;
        }
      } catch (err) {
        this.logger.error(
          `MCP 环境变量解密失败（可能是加密密钥变更）：${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return {};
  }

  /**
   * 运行时使用的「地址」：
   * 远程传输就是真实 URL；STDIO 用 `stdio://<command> <args>` 作为日志/缓存标识，
   * 它不会参与任何网络请求，也不会进 SSRF 校验。
   */
  private endpointOf(row: {
    serverUrl: string | null;
    command: string | null;
    args: unknown;
  }): string {
    if (row.serverUrl) return row.serverUrl;
    const args = Array.isArray(row.args) ? (row.args as string[]) : undefined;
    return stdioEndpointLabel(row.command ?? '', args);
  }

  /** 数据库行 → 运行时配置（凭据与 env 在这里解密，只在服务端内部流转） */
  private toRuntime(
    id: string,
    row: {
      name: string;
      transport: string;
      serverUrl: string | null;
      command: string | null;
      args: unknown;
      envCipher: unknown;
      authType: string;
      credentials: unknown;
    },
  ): McpServerRuntime {
    return {
      id,
      name: row.name,
      transport: row.transport,
      serverUrl: this.endpointOf(row),
      command: row.command ?? undefined,
      args: Array.isArray(row.args) ? (row.args as string[]) : undefined,
      env: this.decryptEnv(row.envCipher),
      authType: row.authType,
      credentials: this.decryptCredentials(row.credentials),
    };
  }

  private assertCredentialsProvided(
    authType: McpAuthType,
    dto: { apiKey?: string; bearerToken?: string },
    isUpdate = false,
  ): void {
    if (authType === 'NONE') return;
    if (authType === 'API_KEY' && !dto.apiKey && !isUpdate) {
      throw new BadRequestException('选择 API_KEY 认证时必须提供 apiKey');
    }
    if (authType === 'BEARER_TOKEN' && !dto.bearerToken && !isUpdate) {
      throw new BadRequestException(
        '选择 BEARER_TOKEN 认证时必须提供 bearerToken',
      );
    }
  }

  private toErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }

  // ===========================================================================
  // 权限工具
  // ===========================================================================

  private assertOwner(userId: string, server: { ownerId: string }) {
    if (server.ownerId !== userId) {
      throw new ForbiddenException('You do not own this MCP server');
    }
  }

  private async assertOwnerExists(userId: string, id: string) {
    const server = await this.prisma.mcpServer.findUnique({
      where: { id },
      select: {
        ownerId: true,
        name: true,
        transport: true,
        serverUrl: true,
        command: true,
        args: true,
        envCipher: true,
        authType: true,
        credentials: true,
      },
    });
    if (!server) throw new NotFoundException('MCP Server not found');
    if (server.ownerId !== userId) {
      throw new ForbiddenException('You do not own this MCP server');
    }
    return server;
  }
}
