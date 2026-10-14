import { Injectable, Logger } from '@nestjs/common';
import type { ToolDefinition } from '../ai/ai-provider.interface';
import { McpConnectionService } from './mcp-connection.service';
import {
  McpProtocolError,
  type McpContentBlock,
  type McpServerRuntimeConfig,
  type McpTool,
  type McpToolCallResult,
} from './types/mcp.types';

/** 一个 MCP 工具在平台内的路由信息 */
export interface McpToolBinding {
  /** 暴露给模型的工具名（默认与 MCP 工具名一致） */
  exposedName: string;
  /** MCP 侧真实工具名 */
  toolName: string;
  /** 该工具所属的 Server 配置（含解密后的凭据） */
  server: McpServerRuntimeConfig;
  /** 来源 Server 显示名，便于日志与错误信息 */
  serverLabel: string;
}

/** 工具调用结果（已规范化，可直接喂回模型） */
export interface McpToolCallOutcome {
  isError: boolean;
  /** 供模型阅读的文本形式 */
  text: string;
  /** 原始结果，含 structuredContent */
  result: McpToolCallResult;
}

/**
 * MCP 工具服务：工具发现、schema 转换、工具调用与结果规范化。
 *
 * 上层（工作流 LLM 节点 / Agent）只面对 ToolDefinition + binding，
 * 不需要知道 MCP 协议细节。
 */
@Injectable()
export class McpToolService {
  private readonly logger = new Logger(McpToolService.name);

  constructor(private readonly connections: McpConnectionService) {}

  /** 发现某个 Server 的全部工具（内部处理分页） */
  async listTools(server: McpServerRuntimeConfig): Promise<McpTool[]> {
    return this.connections.withConnection(server, (c) =>
      c.transport.listTools(),
    );
  }

  /**
   * 把多个 Server 的工具转成模型可用的 ToolDefinition，并返回路由表。
   *
   * 工具重名时保留先出现的那个（MCP 工具名全局唯一性无法保证），并打日志提醒。
   */
  async buildBindings(servers: McpServerRuntimeConfig[]): Promise<{
    tools: ToolDefinition[];
    bindings: Map<string, McpToolBinding>;
  }> {
    const tools: ToolDefinition[] = [];
    const bindings = new Map<string, McpToolBinding>();

    for (const server of servers) {
      const serverLabel = server.id ?? server.serverUrl;

      // 优先复用连接时缓存的工具列表；没有缓存才实时发现
      let availableTools: McpTool[];
      const cached = server.cachedTools;
      if (Array.isArray(cached) && cached.length > 0) {
        availableTools = cached;
      } else {
        try {
          availableTools = await this.listTools(server);
        } catch (err) {
          this.logger.warn(
            `MCP Server ${serverLabel} 工具发现失败，已跳过：${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          continue;
        }
      }

      for (const tool of availableTools) {
        if (!tool?.name) continue;

        if (bindings.has(tool.name)) {
          this.logger.warn(
            `MCP 工具名冲突：${tool.name}（来自 ${serverLabel}），已保留先注册的版本`,
          );
          continue;
        }

        bindings.set(tool.name, {
          exposedName: tool.name,
          toolName: tool.name,
          server,
          serverLabel,
        });
        tools.push(this.toToolDefinition(tool));
      }
    }

    return { tools, bindings };
  }

  /** 调用工具，返回规范化结果（不抛「工具业务错误」，交由调用方决定如何处理） */
  async callTool(
    binding: McpToolBinding,
    args: Record<string, unknown>,
  ): Promise<McpToolCallOutcome> {
    const result = await this.connections.withConnection(binding.server, (c) =>
      c.transport.callTool(binding.toolName, args ?? {}),
    );

    const text = this.formatResult(result);
    return { isError: result.isError === true, text, result };
  }

  /**
   * 便捷方法：直接按 Server 配置调用工具，失败抛错。
   * 用于连接测试 / 调试接口这类「要看到错误」的场景。
   */
  async callToolStrict(
    server: McpServerRuntimeConfig,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpToolCallOutcome> {
    const outcome = await this.callTool(
      {
        exposedName: toolName,
        toolName,
        server,
        serverLabel: server.id ?? server.serverUrl,
      },
      args,
    );
    if (outcome.isError) {
      throw new McpProtocolError(`工具 ${toolName} 执行失败：${outcome.text}`);
    }
    return outcome;
  }

  /** MCP Tool → OpenAI/Ollama 兼容的 ToolDefinition */
  toToolDefinition(tool: McpTool): ToolDefinition {
    const schema = tool.inputSchema ?? {};
    const properties =
      schema.properties && typeof schema.properties === 'object'
        ? schema.properties
        : undefined;

    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? tool.title ?? '',
        parameters: properties
          ? {
              type: 'object',
              // MCP 的 JSON Schema 可能包含嵌套对象 / anyOf，这里原样透传
              properties: properties as Record<string, never>,
              required: Array.isArray(schema.required) ? schema.required : [],
            }
          : undefined,
      },
    };
  }

  /** 把 MCP 结果转成模型可读文本 */
  formatResult(result: McpToolCallResult): string {
    const content = Array.isArray(result.content) ? result.content : [];
    const texts = content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string);

    let text = texts.join('\n').trim();

    if (!text && result.structuredContent !== undefined) {
      text = safeStringify(result.structuredContent);
    }
    if (!text && content.length > 0) {
      text = content.map((c) => describeBlock(c)).join('\n');
    }

    if (result.isError) {
      return text ? `工具返回错误：${text}` : '工具返回错误（无详细信息）';
    }
    return text || '（工具执行成功，但没有返回文本内容）';
  }
}

function describeBlock(block: McpContentBlock): string {
  switch (block.type) {
    case 'image':
      return `[image ${block.mimeType ?? 'unknown'}]`;
    case 'audio':
      return `[audio ${block.mimeType ?? 'unknown'}]`;
    case 'resource':
      return `[resource ${block.uri ?? ''}]`;
    case 'resource_link':
      return `[resource_link ${block.uri ?? ''}]`;
    default:
      return safeStringify(block);
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
