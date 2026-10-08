import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMcpServerDto } from './dto/create-mcp-server.dto';
import { UpdateMcpServerDto } from './dto/update-mcp-server.dto';

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
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class McpService {
  constructor(private readonly prisma: PrismaService) {}

  /** 创建 MCP Server（当前用户作为 owner） */
  create(userId: string, dto: CreateMcpServerDto) {
    return this.prisma.mcpServer.create({
      data: {
        ownerId: userId,
        name: dto.name,
        description: dto.description,
        transport: dto.transport ?? 'STREAMABLE_HTTP',
        serverUrl: dto.serverUrl,
        authType: dto.authType ?? 'NONE',
        credentials: this.buildCredentials(dto) as any,
      },
      select: mcpSelection,
    });
  }

  /** 获取当前用户的全部 MCP Servers */
  findAll(userId: string) {
    return this.prisma.mcpServer.findMany({
      where: { ownerId: userId },
      orderBy: { createdAt: 'desc' },
      select: mcpSelection,
    });
  }

  /**
   * 按 ID 列表批量获取 MCP Servers（工作流执行时用，无需 owner 校验）。
   * 包含 credentials，用于运行时调用 MCP Server。
   */
  findByIds(ids: string[]) {
    if (ids.length === 0) return [];
    return this.prisma.mcpServer.findMany({
      where: { id: { in: ids } },
      select: {
        ...mcpSelection,
        credentials: true,
      },
    });
  }

  /** 获取单个 MCP Server（owner 校验） */
  async findOne(userId: string, id: string) {
    const server = await this.prisma.mcpServer.findUnique({
      where: { id },
      select: mcpSelection,
    });
    if (!server) throw new NotFoundException('MCP Server not found');
    this.assertOwner(userId, server);
    return server;
  }

  /** 更新 MCP Server */
  async update(userId: string, id: string, dto: UpdateMcpServerDto) {
    const server = await this.assertOwnerExists(userId, id);

    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.transport !== undefined) data.transport = dto.transport;
    if (dto.serverUrl !== undefined) data.serverUrl = dto.serverUrl;
    if (dto.authType !== undefined) data.authType = dto.authType;

    // 如果有凭证更新，合并到现有 credentials
    if (dto.apiKey !== undefined || dto.bearerToken !== undefined) {
      const existing =
        (server.credentials as Record<string, unknown>) ?? {};
      if (dto.apiKey !== undefined) existing.apiKey = dto.apiKey;
      if (dto.bearerToken !== undefined)
        existing.bearerToken = dto.bearerToken;
      data.credentials = existing as any;
    }

    // URL 或认证方式变更时重置连接状态
    if (dto.serverUrl !== undefined || dto.authType !== undefined) {
      data.status = 'DISCONNECTED';
      data.lastError = null;
      data.availableTools = null as any;
    }

    return this.prisma.mcpServer.update({
      where: { id },
      data,
      select: mcpSelection,
    });
  }

  /** 删除 MCP Server */
  async remove(userId: string, id: string) {
    await this.assertOwnerExists(userId, id);
    return this.prisma.mcpServer.delete({
      where: { id },
      select: mcpSelection,
    });
  }

  // ===========================================================================
  // 连接测试 + 获取 Tools
  // ===========================================================================

  /** 测试 MCP Server 连接，获取可用 tools 并缓存到数据库 */
  async testConnection(userId: string, id: string) {
    const server = await this.prisma.mcpServer.findUnique({
      where: { id },
      select: {
        id: true,
        ownerId: true,
        transport: true,
        serverUrl: true,
        authType: true,
        credentials: true,
      },
    });
    if (!server) throw new NotFoundException('MCP Server not found');
    this.assertOwner(userId, server);

    try {
      const tools = await this.fetchTools(server);
      await this.prisma.mcpServer.update({
        where: { id },
        data: {
          status: 'CONNECTED',
          lastError: null,
          availableTools: tools as any,
        },
      });
      return {
        success: true,
        status: 'CONNECTED',
        tools,
        message: `连接成功，发现 ${tools.length} 个可用工具`,
      };
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : '连接失败';
      await this.prisma.mcpServer.update({
        where: { id },
        data: {
          status: 'ERROR',
          lastError: errorMsg,
          availableTools: null as any,
        },
      });
      return {
        success: false,
        status: 'ERROR',
        tools: [],
        message: errorMsg,
      };
    }
  }

  // ===========================================================================
  // 工作流运行时：工具调用 + ToolDefinition 构建
  // ===========================================================================

  /**
   * 调用 MCP Server 上的某个工具。
   * 工作流 LLM 节点执行时，当 LLM 返回 tool_calls 后调用此方法。
   */
  async callTool(
    server: {
      transport: string;
      serverUrl: string;
      authType: string;
      credentials: unknown;
    },
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (server.transport === 'SSE') {
      throw new Error('SSE 传输方式暂不支持工具调用，请使用 Streamable HTTP');
    }

    const headers = this.buildHeaders(
      server.authType,
      server.credentials as Record<string, unknown> | null,
    );

    // Step 1: Initialize
    const initResponse = await fetch(server.serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'ai-workflow-studio', version: '1.0.0' },
        },
      }),
    });

    if (!initResponse.ok) {
      throw new Error(`MCP initialize 失败: HTTP ${initResponse.status}`);
    }

    await this.parseMcpResponse(initResponse);

    // Step 2: notifications/initialized
    await fetch(server.serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });

    // Step 3: tools/call
    const callResponse = await fetch(server.serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args,
        },
      }),
    });

    if (!callResponse.ok) {
      throw new Error(
        `tools/call 请求失败: HTTP ${callResponse.status}`,
      );
    }

    const callResult = await this.parseMcpResponse(callResponse);
    if (callResult.error) {
      throw new Error(
        `工具调用失败: ${JSON.stringify(callResult.error)}`,
      );
    }

    const result = callResult.result as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };

    if (result?.isError) {
      const errorText = result.content?.[0]?.text || '工具执行返回错误';
      throw new Error(errorText);
    }

    // 提取文本内容
    if (result?.content && Array.isArray(result.content)) {
      const texts = result.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text || '');
      return texts.join('\n');
    }

    return callResult.result;
  }

  // ===========================================================================
  // MCP 协议通信
  // ===========================================================================

  private async fetchTools(server: {
    transport: string;
    serverUrl: string;
    authType: string;
    credentials: unknown;
  }): Promise<unknown[]> {
    if (server.transport === 'SSE') {
      throw new Error(
        'SSE 传输方式暂不支持自动连接测试，请使用 Streamable HTTP',
      );
    }

    const headers = this.buildHeaders(
      server.authType,
      server.credentials as Record<string, unknown> | null,
    );

    // Step 1: Initialize 握手
    const initResponse = await fetch(server.serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'ai-workflow-studio',
            version: '1.0.0',
          },
        },
      }),
    });

    if (!initResponse.ok) {
      throw new Error(
        `MCP Server 返回 HTTP ${initResponse.status}: ${initResponse.statusText}`,
      );
    }

    const initResult = await this.parseMcpResponse(initResponse);
    if (initResult.error) {
      throw new Error(
        `MCP initialize 失败: ${JSON.stringify(initResult.error)}`,
      );
    }

    // Step 2: 发送 initialized 通知（无需等待响应）
    await fetch(server.serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });

    // Step 3: 获取 tools 列表
    const toolsResponse = await fetch(server.serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }),
    });

    if (!toolsResponse.ok) {
      throw new Error(
        `tools/list 请求失败: HTTP ${toolsResponse.status}`,
      );
    }

    const toolsResult = await this.parseMcpResponse(toolsResponse);
    if (toolsResult.error) {
      throw new Error(
        `tools/list 失败: ${JSON.stringify(toolsResult.error)}`,
      );
    }

    const tools = (toolsResult.result as { tools?: unknown[] })?.tools;
    return Array.isArray(tools) ? tools : [];
  }

  private async parseMcpResponse(
    response: Response,
  ): Promise<{ result?: unknown; error?: unknown }> {
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('text/event-stream')) {
      const text = await response.text();
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            return JSON.parse(line.slice(6).trim());
          } catch {
            // 继续找下一行
          }
        }
      }
      throw new Error('MCP Server SSE 响应中没有找到有效数据');
    }

    return response.json();
  }

  private buildHeaders(
    authType: string,
    credentials: Record<string, unknown> | null,
  ): Record<string, string> {
    const headers: Record<string, string> = {};
    if (authType === 'API_KEY' && credentials?.apiKey) {
      headers['X-API-Key'] = String(credentials.apiKey);
    } else if (authType === 'BEARER_TOKEN' && credentials?.bearerToken) {
      headers['Authorization'] = `Bearer ${credentials.bearerToken}`;
    }
    return headers;
  }

  private buildCredentials(dto: CreateMcpServerDto): Record<string, unknown> {
    const creds: Record<string, unknown> = {};
    if (dto.apiKey) creds.apiKey = dto.apiKey;
    if (dto.bearerToken) creds.bearerToken = dto.bearerToken;
    return creds;
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
      select: { ownerId: true, credentials: true },
    });
    if (!server) throw new NotFoundException('MCP Server not found');
    if (server.ownerId !== userId) {
      throw new ForbiddenException('You do not own this MCP server');
    }
    return server;
  }
}
