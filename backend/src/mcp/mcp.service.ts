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
} from './types/mcp.types';

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
    // 同步校验 URL 形态（协议 / 内网主机 / 内嵌凭据），快速失败
    this.urlGuard.assertSafeUrlShape(dto.serverUrl);

    const authType = (dto.authType ?? 'NONE') as McpAuthType;
    this.assertCredentialsProvided(authType, dto);

    const server = await this.prisma.mcpServer.create({
      data: {
        ownerId: userId,
        name: dto.name,
        description: dto.description,
        transport: dto.transport ?? 'STREAMABLE_HTTP',
        serverUrl: dto.serverUrl,
        authType,
        credentials: this.encryptCredentials(dto) as never,
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
        authType: true,
        credentials: true,
        availableTools: true,
      },
    });

    return servers.map((s) => ({
      id: s.id,
      name: s.name,
      transport: s.transport,
      serverUrl: s.serverUrl,
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

    if (dto.serverUrl !== undefined) {
      this.urlGuard.assertSafeUrlShape(dto.serverUrl);
    }

    const nextAuthType = (dto.authType ?? existing.authType) as McpAuthType;
    this.assertCredentialsProvided(nextAuthType, dto, true);

    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.transport !== undefined) data.transport = dto.transport;
    if (dto.serverUrl !== undefined) data.serverUrl = dto.serverUrl;
    if (dto.authType !== undefined) data.authType = dto.authType;

    // 凭据更新：与现有解密后的凭据合并后重新加密
    if (
      dto.apiKey !== undefined ||
      dto.bearerToken !== undefined ||
      dto.authType !== undefined
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
      dto.bearerToken !== undefined;

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
      serverUrl: string;
      authType: string;
      credentials: unknown;
    },
  ) {
    const runtime: McpServerRuntime = {
      id,
      name: server.name,
      transport: server.transport,
      serverUrl: server.serverUrl,
      authType: server.authType,
      credentials: this.decryptCredentials(server.credentials),
    };

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
    const runtime: McpServerRuntime = {
      id,
      name: server.name,
      transport: server.transport,
      serverUrl: server.serverUrl,
      authType: server.authType,
      credentials: this.decryptCredentials(server.credentials),
    };

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
    const runtime: McpServerRuntime = {
      id,
      name: server.name,
      transport: server.transport,
      serverUrl: server.serverUrl,
      authType: server.authType,
      credentials: this.decryptCredentials(server.credentials),
    };
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
   * 剥离 credentials，只保留「是否已配置凭据 + 掩码预览」。
   */
  private toPublicServer<T extends { credentials?: unknown }>(server: T) {
    const { credentials, ...rest } = server;
    const creds = this.decryptCredentials(credentials);
    const secret = creds.bearerToken ?? creds.apiKey ?? null;

    return {
      ...rest,
      hasCredentials: Boolean(secret),
      credentialPreview: secret ? this.encryption.maskApiKey(secret) : null,
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
