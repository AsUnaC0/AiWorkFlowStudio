import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { McpService } from '../../mcp/mcp.service';
import { SkillService } from '../../skill/skill.service';
import type {
  PlatformTool,
  PlatformToolContext,
  PlatformToolOutcome,
} from '../platform-tool.interface';
import {
  asOptionalString,
  asRecord,
  asString,
} from '../platform-tool.interface';

/**
 * Skill / MCP / 平台总览 相关工具。
 *
 * 三个查询工具（list_skills / list_mcp_servers / get_platform_overview）是「只读能力清单」——
 * 让平台助理在回答「我有哪些能力」「哪些 MCP 掉线了」「还有哪些知识库没索引完」这类问题时，
 * 能一次拿到全局视图，而不是让模型逐个工具串行试探。
 *
 * 两个写工具（create_mcp_server / create_skill）都遵守同一条红线：
 *   **不接收任何密钥/令牌**。MCP 的 apiKey / bearerToken 只能由用户在 /mcp 页面填写，
 *   因为聊天正文与审计日志都会把工具入参原样落库，密钥从聊天进来就是明文入库。
 */
const MCP_TRANSPORTS: string[] = ['STREAMABLE_HTTP', 'SSE'];
const MCP_AUTH_TYPES: string[] = ['NONE', 'API_KEY', 'BEARER_TOKEN'];
const SKILL_TYPES: string[] = ['PROMPT', 'WORKFLOW', 'TOOL'];
const SKILL_OUTPUT_FORMATS: string[] = ['Markdown', 'JSON', 'Text'];

/**
 * 把连接错误压缩成一行给模型看。
 *
 * MCP 握手失败时 err.message 常常夹带整个响应体（比如 405 返回的整页 HTML），
 * 原样塞进工具结果既浪费上下文，也会让模型抓错重点。
 */
function briefError(message: string): string {
  const text = message
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

@Injectable()
export class SkillMcpTools {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mcpService: McpService,
    private readonly skillService: SkillService,
  ) {}

  readonly tools: PlatformTool[] = [
    {
      name: 'list_skills',
      meta: {
        label: '查询 Skill',
        action: 'QUERY',
        riskLevel: 'LOW',
        targetType: 'skill',
      },
      definition: {
        type: 'function',
        function: {
          name: 'list_skills',
          description:
            '查询当前用户的 Skill 列表（PROMPT / WORKFLOW / TOOL 三种类型），含绑定的工作流或 MCP 工具。',
          parameters: {
            type: 'object',
            properties: {
              keyword: {
                type: 'string',
                description: '可选：按名称模糊筛选',
              },
            },
          },
        },
      },
      execute: (args, ctx) => this.listSkills(args, ctx),
    },

    {
      name: 'list_mcp_servers',
      meta: {
        label: '查询 MCP Server',
        action: 'QUERY',
        riskLevel: 'LOW',
        targetType: 'mcp_server',
      },
      definition: {
        type: 'function',
        function: {
          name: 'list_mcp_servers',
          description:
            '查询当前用户配置的 MCP Server 列表，含连接状态、最近错误、已发现的工具数量。' +
            '当用户问「哪些 MCP 连不上」时使用。',
          parameters: {
            type: 'object',
            properties: {
              keyword: {
                type: 'string',
                description: '可选：按名称模糊筛选',
              },
            },
          },
        },
      },
      execute: (args, ctx) => this.listMcpServers(args, ctx),
    },

    {
      name: 'get_platform_overview',
      meta: {
        label: '查询平台总览',
        action: 'QUERY',
        riskLevel: 'LOW',
        targetType: 'platform',
      },
      definition: {
        type: 'function',
        function: {
          name: 'get_platform_overview',
          description:
            '一次性获取平台资源总览：工作空间 / 工作流（含发布与失败情况）/ 知识库（含索引进度）/ Agent / Skill / MCP 的状态汇总，' +
            '以及当前工作空间信息。适合回答「我的平台现在什么情况」「有哪些需要处理的问题」。',
          parameters: {
            type: 'object',
            properties: {},
          },
        },
      },
      execute: (_args, ctx) => this.overview(ctx),
    },

    {
      name: 'create_mcp_server',
      meta: {
        label: '创建 MCP Server',
        action: 'CREATE',
        riskLevel: 'MEDIUM',
        targetType: 'mcp_server',
      },
      definition: {
        type: 'function',
        function: {
          name: 'create_mcp_server',
          description: [
            '为当前用户创建一条 MCP Server 配置。认证方式为 NONE 时会自动测试连接并发现可用工具。',
            '【重要】本工具不接收任何密钥：不要传 apiKey / bearerToken，密钥只能由用户到 /mcp 页面手动填写。',
            '若目标 Server 需要认证，把 authType 设为 API_KEY 或 BEARER_TOKEN，创建后告知用户去页面补填密钥。',
            '创建成功后返回 id 与 MCP 管理页链接；可再用 create_agent 把它绑定到新建的 Agent。',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'MCP Server 名称（展示用，例如「高德地图 MCP」）',
              },
              serverUrl: {
                type: 'string',
                description:
                  'MCP 服务地址（完整 URL，http/https，例如 https://mcp.example.com/mcp）',
              },
              transport: {
                type: 'string',
                enum: ['STREAMABLE_HTTP', 'SSE'],
                description:
                  '传输方式：STREAMABLE_HTTP（推荐，新式协议）/ SSE（旧版 HTTP+SSE）。默认 STREAMABLE_HTTP',
              },
              authType: {
                type: 'string',
                enum: ['NONE', 'API_KEY', 'BEARER_TOKEN'],
                description:
                  '认证方式，默认 NONE。选 API_KEY / BEARER_TOKEN 时凭据仍需用户自行在页面填写',
              },
              description: {
                type: 'string',
                description: '可选：用途说明',
              },
            },
            required: ['name', 'serverUrl'],
          },
        },
      },
      execute: (args, ctx) => this.createMcpServer(args, ctx),
    },

    {
      name: 'create_skill',
      meta: {
        label: '创建 Skill',
        action: 'CREATE',
        riskLevel: 'MEDIUM',
        targetType: 'skill',
      },
      definition: {
        type: 'function',
        function: {
          name: 'create_skill',
          description: [
            '为当前用户创建一个 Skill（可复用的能力封装）。三种类型：',
            '- PROMPT：纯指令模板，必须提供 instructions（告诉模型怎么做这类任务）；',
            '- WORKFLOW：调用已发布工作流，必须提供 workflowId（先用 list_workflows 查真实 id）；',
            '- TOOL：调用某个 MCP Server 上的具体工具，必须提供 mcpServerId + mcpToolName（先用 list_mcp_servers 查）。',
            '创建后返回 id 与 Skills 管理页链接。',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Skill 名称（例如「合同条款审查」）',
              },
              type: {
                type: 'string',
                enum: ['PROMPT', 'WORKFLOW', 'TOOL'],
                description: 'Skill 类型，默认 PROMPT',
              },
              description: {
                type: 'string',
                description: '可选：用途说明',
              },
              instructions: {
                type: 'string',
                description:
                  'PROMPT 类型必填：注入给模型的指令正文（角色、步骤、输出要求）',
              },
              outputFormat: {
                type: 'string',
                enum: ['Markdown', 'JSON', 'Text'],
                description: '输出格式，默认 Markdown',
              },
              inputSchema: {
                type: 'object',
                description:
                  '可选：输入参数的 JSON Schema（模型可见的 function parameters）',
              },
              workflowId: {
                type: 'string',
                description: 'WORKFLOW 类型必填：绑定的工作流 id（必须已发布）',
              },
              mcpServerId: {
                type: 'string',
                description: 'TOOL 类型必填：绑定的 MCP Server id',
              },
              mcpToolName: {
                type: 'string',
                description: 'TOOL 类型必填：MCP Server 上的工具名',
              },
            },
            required: ['name'],
          },
        },
      },
      execute: (args, ctx) => this.createSkill(args, ctx),
    },
  ];

  // =========================================================================
  // 实现
  // =========================================================================

  private async listSkills(
    args: Record<string, unknown>,
    ctx: PlatformToolContext,
  ): Promise<PlatformToolOutcome> {
    const keyword = asOptionalString(args.keyword);

    const skills = await this.prisma.skill.findMany({
      where: {
        ownerId: ctx.userId,
        ...(keyword
          ? { name: { contains: keyword, mode: 'insensitive' } }
          : {}),
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        description: true,
        type: true,
        workflowId: true,
        mcpServerId: true,
        mcpToolName: true,
        outputFormat: true,
      },
    });

    if (skills.length === 0) {
      return {
        text: '当前用户还没有创建 Skill。',
        targetType: 'skill',
        summary: '查询 Skill（0 个）',
      };
    }

    const lines = skills.map((s) =>
      [
        `- ${s.name}｜id=${s.id}｜类型=${s.type}｜输出=${s.outputFormat}`,
        s.workflowId ? `  绑定工作流=${s.workflowId}` : '',
        s.mcpServerId
          ? `  绑定 MCP=${s.mcpServerId}${s.mcpToolName ? ` / ${s.mcpToolName}` : ''}`
          : '',
        s.description ? `  说明=${s.description}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );

    return {
      text: `共 ${skills.length} 个 Skill：\n${lines.join('\n')}`,
      targetType: 'skill',
      summary: `查询 Skill（${skills.length} 个）`,
    };
  }

  private async listMcpServers(
    args: Record<string, unknown>,
    ctx: PlatformToolContext,
  ): Promise<PlatformToolOutcome> {
    const keyword = asOptionalString(args.keyword);

    const servers = await this.prisma.mcpServer.findMany({
      where: {
        ownerId: ctx.userId,
        ...(keyword
          ? { name: { contains: keyword, mode: 'insensitive' } }
          : {}),
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        description: true,
        transport: true,
        authType: true,
        status: true,
        lastError: true,
        availableTools: true,
        serverName: true,
        lastConnectedAt: true,
      },
    });

    if (servers.length === 0) {
      return {
        text: '当前用户还没有配置 MCP Server。',
        targetType: 'mcp_server',
        summary: '查询 MCP Server（0 个）',
      };
    }

    const lines = servers.map((s) => {
      const toolCount = Array.isArray(s.availableTools)
        ? s.availableTools.length
        : 0;
      return [
        `- ${s.name}｜id=${s.id}｜状态=${s.status}`,
        `  传输=${s.transport}｜认证=${s.authType}｜可用工具=${toolCount}${
          s.serverName ? `｜服务端=${s.serverName}` : ''
        }`,
        s.lastError ? `  ⚠️ 最近错误：${s.lastError}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    });

    const broken = servers.filter((s) => s.status === 'ERROR').length;

    return {
      text: `共 ${servers.length} 个 MCP Server（异常 ${broken} 个）：\n${lines.join('\n')}`,
      targetType: 'mcp_server',
      summary: `查询 MCP Server（${servers.length} 个，异常 ${broken} 个）`,
    };
  }

  // =========================================================================
  // 写操作：创建 MCP Server / Skill
  // =========================================================================

  /**
   * 创建 MCP Server。
   *
   * 三条设计约束（都源于「密钥不能经过聊天」）：
   *   1. 入参里没有 apiKey / bearerToken —— 模型若硬塞，直接拒绝，不落库；
   *   2. authType 为 NONE 才自动测试连接；需要认证的只建配置，凭据等用户在页面补；
   *   3. 创建后状态由 testConnection 决定（CONNECTED / ERROR / DISCONNECTED），
   *      绝不假称"已连接可用"。
   */
  private async createMcpServer(
    args: Record<string, unknown>,
    ctx: PlatformToolContext,
  ): Promise<PlatformToolOutcome> {
    const name = asString(args.name);
    if (!name) {
      return {
        text: '错误：name 不能为空。',
        status: 'FAILED',
        summary: '缺少 MCP Server 名称',
      };
    }

    const serverUrl = asString(args.serverUrl);
    if (!serverUrl) {
      return {
        text: '错误：serverUrl 不能为空。',
        status: 'FAILED',
        summary: '缺少 MCP Server 地址',
      };
    }

    const transport = (
      asOptionalString(args.transport) ?? 'STREAMABLE_HTTP'
    ).toUpperCase();
    if (!MCP_TRANSPORTS.includes(transport)) {
      return {
        text: `错误：不支持的 transport「${transport}」，可选：${MCP_TRANSPORTS.join(' / ')}。`,
        status: 'FAILED',
        summary: 'transport 不合法',
      };
    }

    const authType = (asOptionalString(args.authType) ?? 'NONE').toUpperCase();
    if (!MCP_AUTH_TYPES.includes(authType)) {
      return {
        text: `错误：不支持的 authType「${authType}」，可选：${MCP_AUTH_TYPES.join(' / ')}。`,
        status: 'FAILED',
        summary: 'authType 不合法',
      };
    }

    // 密钥红线：模型可能自作主张把 apiKey / bearerToken 塞进参数。
    // 直接失败而不是静默丢弃 —— 静默丢弃会让模型以为凭据已配置好。
    const leakedSecret =
      asOptionalString(args.apiKey) ?? asOptionalString(args.bearerToken);
    if (leakedSecret) {
      return {
        text: [
          '错误：本工具不接收 apiKey / bearerToken，创建未执行。',
          '请不要在对话中传递密钥 —— 聊天记录与平台审计日志都会落库保存。',
          '请去掉密钥参数后重试：只创建配置，密钥由用户到 /mcp 页面手动填写。',
        ].join('\n'),
        status: 'FAILED',
        summary: '拒绝接收密钥',
      };
    }

    // 同地址去重：模型重试时避免创建一堆重复配置
    const existing = await this.prisma.mcpServer.findFirst({
      where: { ownerId: ctx.userId, serverUrl },
      select: { id: true, name: true, status: true },
    });
    if (existing) {
      return {
        text: [
          `已存在同地址的 MCP Server「${existing.name}」(id=${existing.id}｜状态=${existing.status})，未重复创建。`,
          '如需修改配置或测试连接，请到 /mcp 页面操作。',
        ].join('\n'),
        targetType: 'mcp_server',
        targetId: existing.id,
        targetName: existing.name,
        link: '/mcp',
        summary: `MCP Server 已存在（${existing.name}）`,
      };
    }

    let created: { id: string; name: string };
    try {
      created = await this.mcpService.createPendingCredentials(ctx.userId, {
        name,
        description: asOptionalString(args.description),
        transport,
        serverUrl,
        authType,
      });
    } catch (err) {
      // SSRF 校验（内网地址 / 非 http(s) 协议 / 内嵌凭据）会在这里抛出
      return {
        text: `创建失败：${err instanceof Error ? err.message : String(err)}`,
        status: 'FAILED',
        summary: '创建 MCP Server 失败',
      };
    }

    const base = `已创建 MCP Server「${created.name}」｜id=${created.id}｜传输=${transport}｜认证=${authType}`;

    // 需要认证：没有凭据时测试必然失败，跳过测试，直接引导用户补密钥
    if (authType !== 'NONE') {
      const secretLabel = authType === 'API_KEY' ? 'API Key' : 'Bearer Token';
      return {
        text: [
          base,
          `凭据未配置（本工具不接收密钥）。请用户到 /mcp 页面编辑该 Server，填入 ${secretLabel}，再点「测试连接」。`,
          '在凭据补齐前，它处于 DISCONNECTED 状态，无法被 Agent 调用。',
        ].join('\n'),
        targetType: 'mcp_server',
        targetId: created.id,
        targetName: created.name,
        link: '/mcp',
        summary: `创建 MCP Server「${created.name}」（待填凭据）`,
      };
    }

    // 无认证：自动握手 + 发现工具，把真实结果写回状态
    const test = await this.mcpService.testConnection(ctx.userId, created.id);

    if (!test.success) {
      return {
        text: [
          base,
          `但连接测试失败：${briefError(test.message)}`,
          '常见原因：URL 路径不对（不少 Server 需要以 /mcp 或 /sse 结尾）、服务未启动、或该地址其实需要认证。',
          '请用户核对后到 /mcp 页面修改配置并重新测试。',
        ].join('\n'),
        targetType: 'mcp_server',
        targetId: created.id,
        targetName: created.name,
        link: '/mcp',
        summary: `创建 MCP Server「${created.name}」（连接失败）`,
      };
    }

    const preview = test.tools.slice(0, 12).map((t) => t.name);
    return {
      text: [
        `${base}｜状态=CONNECTED`,
        `连接成功，发现 ${test.tools.length} 个工具${
          test.serverInfo?.name ? `（服务端 ${test.serverInfo.name}）` : ''
        }：`,
        preview.length
          ? `- ${preview.join('\n- ')}`
          : '（该 Server 未暴露任何工具）',
        test.tools.length > preview.length
          ? `……共 ${test.tools.length} 个，此处仅列前 ${preview.length} 个`
          : '',
        '',
        `下一步可选：用 create_agent 把它（mcpServerIds=["${created.id}"]）绑定到新建的 Agent。`,
      ]
        .filter(Boolean)
        .join('\n'),
      targetType: 'mcp_server',
      targetId: created.id,
      targetName: created.name,
      link: '/mcp',
      summary: `创建 MCP Server「${created.name}」（${test.tools.length} 个工具）`,
    };
  }

  /**
   * 创建 Skill。
   *
   * 三种类型的必填项不同，且绑定的资源必须属于当前用户 —— 这里逐个校验，
   * 因为 SkillService.create 本身不做归属校验（它信任调用方）。
   */
  private async createSkill(
    args: Record<string, unknown>,
    ctx: PlatformToolContext,
  ): Promise<PlatformToolOutcome> {
    const name = asString(args.name);
    if (!name) {
      return {
        text: '错误：name 不能为空。',
        status: 'FAILED',
        summary: '缺少 Skill 名称',
      };
    }

    const type = (asOptionalString(args.type) ?? 'PROMPT').toUpperCase();
    if (!SKILL_TYPES.includes(type)) {
      return {
        text: `错误：不支持的 type「${type}」，可选：${SKILL_TYPES.join(' / ')}。`,
        status: 'FAILED',
        summary: 'Skill 类型不合法',
      };
    }

    const outputFormat = asOptionalString(args.outputFormat) ?? 'Markdown';
    if (!SKILL_OUTPUT_FORMATS.includes(outputFormat)) {
      return {
        text: `错误：不支持的 outputFormat「${outputFormat}」，可选：${SKILL_OUTPUT_FORMATS.join(' / ')}。`,
        status: 'FAILED',
        summary: '输出格式不合法',
      };
    }

    const instructions = asOptionalString(args.instructions);
    const workflowId = asOptionalString(args.workflowId);
    const mcpServerId = asOptionalString(args.mcpServerId);
    const mcpToolName = asOptionalString(args.mcpToolName);

    if (type === 'PROMPT' && !instructions) {
      return {
        text: '错误：PROMPT 类型的 Skill 必须提供 instructions（指令正文）。',
        status: 'FAILED',
        summary: '缺少 instructions',
      };
    }

    const warnings: string[] = [];

    if (type === 'WORKFLOW') {
      if (!workflowId) {
        return {
          text: '错误：WORKFLOW 类型的 Skill 必须提供 workflowId（先用 list_workflows 查真实 id）。',
          status: 'FAILED',
          summary: '缺少 workflowId',
        };
      }
      const workflow = await this.prisma.workflow.findFirst({
        where: {
          id: workflowId,
          workspace: {
            OR: [
              { ownerId: ctx.userId },
              { members: { some: { userId: ctx.userId } } },
            ],
          },
        },
        select: {
          id: true,
          name: true,
          publishedVersion: { select: { version: true } },
        },
      });
      if (!workflow) {
        return {
          text: `错误：工作流 ${workflowId} 不存在，或当前用户无权访问。`,
          status: 'FAILED',
          summary: '工作流不存在或无权访问',
        };
      }
      if (!workflow.publishedVersion) {
        warnings.push(
          `⚠️ 工作流「${workflow.name}」尚未发布，Skill 只有在它发布后才能正常调用。`,
        );
      }
    }

    if (type === 'TOOL') {
      if (!mcpServerId || !mcpToolName) {
        return {
          text: '错误：TOOL 类型的 Skill 必须提供 mcpServerId 和 mcpToolName。',
          status: 'FAILED',
          summary: '缺少 MCP 绑定信息',
        };
      }
      const server = await this.prisma.mcpServer.findFirst({
        where: { id: mcpServerId, ownerId: ctx.userId },
        select: {
          id: true,
          name: true,
          status: true,
          availableTools: true,
        },
      });
      if (!server) {
        return {
          text: `错误：MCP Server ${mcpServerId} 不存在，或当前用户无权访问。`,
          status: 'FAILED',
          summary: 'MCP Server 不存在或无权访问',
        };
      }
      // 工具名校验只做提示不阻断 —— availableTools 是缓存，可能已过期
      const cachedNames = Array.isArray(server.availableTools)
        ? (server.availableTools as Array<{ name?: unknown }>)
            .map((t) => (typeof t?.name === 'string' ? t.name : ''))
            .filter(Boolean)
        : [];
      if (cachedNames.length > 0 && !cachedNames.includes(mcpToolName)) {
        warnings.push(
          `⚠️ MCP Server「${server.name}」的缓存工具列表里没有「${mcpToolName}」，` +
            `可能是工具名拼错或缓存过期（可在 /mcp 页面刷新工具列表）。`,
        );
      }
    }

    let created: { id: string; name: string };
    try {
      created = await this.skillService.create(ctx.userId, {
        name,
        description: asOptionalString(args.description),
        type,
        instructions,
        inputSchema: asRecord(args.inputSchema) as never,
        outputFormat,
        workflowId,
        mcpServerId,
        mcpToolName,
      });
    } catch (err) {
      return {
        text: `创建失败：${err instanceof Error ? err.message : String(err)}`,
        status: 'FAILED',
        summary: '创建 Skill 失败',
      };
    }

    return {
      text: [
        `已创建 Skill「${created.name}」｜id=${created.id}｜类型=${type}｜输出=${outputFormat}`,
        type === 'WORKFLOW' ? `绑定工作流=${workflowId}` : '',
        type === 'TOOL' ? `绑定 MCP=${mcpServerId} / ${mcpToolName}` : '',
        ...warnings,
        '',
        '入口链接：/skills（可在页面继续编辑或删除）。',
        '⚠️ 现状说明：Skill 的 instructions 目前只在「工作流的 LLM 节点」里注入生效；' +
          'Agent 运行时尚未接入 Skill（Agent 配置页可以绑定，但暂无运行时效果）。',
      ]
        .filter(Boolean)
        .join('\n'),
      targetType: 'skill',
      targetId: created.id,
      targetName: created.name,
      link: '/skills',
      summary: `创建 Skill「${created.name}」（${type}）`,
    };
  }

  private async overview(
    ctx: PlatformToolContext,
  ): Promise<PlatformToolOutcome> {
    const userId = ctx.userId;

    const [
      workspaces,
      workflowTotal,
      workflowByStatus,
      knowledgeBases,
      documentsByStatus,
      agentCount,
      skillCount,
      mcpServers,
      recentFailedRuns,
      operationStats,
    ] = await Promise.all([
      this.prisma.workspace.findMany({
        where: {
          OR: [{ ownerId: userId }, { members: { some: { userId } } }],
        },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          name: true,
          ownerId: true,
          _count: { select: { workflows: true, members: true } },
        },
      }),
      this.prisma.workflow.count({
        where: {
          workspace: {
            OR: [{ ownerId: userId }, { members: { some: { userId } } }],
          },
        },
      }),
      this.prisma.workflow.groupBy({
        by: ['status'],
        where: {
          workspace: {
            OR: [{ ownerId: userId }, { members: { some: { userId } } }],
          },
        },
        _count: { _all: true },
      }),
      this.prisma.knowledgeBase.findMany({
        where: { ownerId: userId },
        select: {
          id: true,
          name: true,
          documentCount: true,
          chunkCount: true,
          documents: { select: { status: true } },
        },
      }),
      this.prisma.document.groupBy({
        by: ['status'],
        where: { knowledgeBase: { ownerId: userId } },
        _count: { _all: true },
      }),
      this.prisma.agent.count({ where: { createdBy: userId } }),
      this.prisma.skill.count({ where: { ownerId: userId } }),
      this.prisma.mcpServer.findMany({
        where: { ownerId: userId },
        select: { id: true, name: true, status: true },
      }),
      this.prisma.workflowRun.findMany({
        where: {
          status: 'FAILED',
          workflow: {
            workspace: {
              OR: [{ ownerId: userId }, { members: { some: { userId } } }],
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          createdAt: true,
          errorCode: true,
          errorMessage: true,
          workflow: { select: { id: true, name: true } },
        },
      }),
      this.prisma.platformOperationLog.groupBy({
        by: ['status'],
        where: { userId },
        _count: { _all: true },
      }),
    ]);

    const statusCount = (status: string) =>
      workflowByStatus.find((g) => g.status === status)?._count._all ?? 0;
    const docStatus = (status: string) =>
      documentsByStatus.find((g) => g.status === status)?._count._all ?? 0;

    const incompleteKbs = knowledgeBases.filter((kb) =>
      kb.documents.some(
        (d) =>
          d.status === 'UPLOADED' ||
          d.status === 'PROCESSING' ||
          d.status === 'FAILED',
      ),
    );
    const brokenMcp = mcpServers.filter((s) => s.status === 'ERROR');

    const currentWorkspace = workspaces.find((w) => w.id === ctx.workspaceId);

    const lines: string[] = [
      '【平台资源总览】',
      `工作空间：${workspaces.length} 个${
        currentWorkspace
          ? `（当前：${currentWorkspace.name}）`
          : '（未指定当前工作空间）'
      }`,
      `工作流：${workflowTotal} 个（草稿 ${statusCount('DRAFT')}｜已发布 ${statusCount('PUBLISHED')}｜已归档 ${statusCount('ARCHIVED')}）`,
      `知识库：${knowledgeBases.length} 个｜文档总数 ${documentsByStatus.reduce(
        (sum, g) => sum + g._count._all,
        0,
      )}（已完成 ${docStatus('COMPLETED')}｜处理中 ${
        docStatus('UPLOADED') + docStatus('PROCESSING')
      }｜失败 ${docStatus('FAILED')}）`,
      `Agent：${agentCount} 个（不含系统内置）`,
      `Skill：${skillCount} 个`,
      `MCP Server：${mcpServers.length} 个（异常 ${brokenMcp.length} 个）`,
    ];

    if (workspaces.length > 0) {
      lines.push('', '工作空间明细：');
      for (const ws of workspaces) {
        lines.push(
          `- ${ws.name}（id=${ws.id}）｜角色=${
            ws.ownerId === userId ? 'OWNER' : 'MEMBER'
          }｜工作流 ${ws._count.workflows}｜成员 ${ws._count.members}`,
        );
      }
    }

    if (incompleteKbs.length > 0) {
      lines.push('', '⚠️ 索引未完成的知识库：');
      for (const kb of incompleteKbs) {
        const pending = kb.documents.filter(
          (d) => d.status === 'UPLOADED' || d.status === 'PROCESSING',
        ).length;
        const failed = kb.documents.filter((d) => d.status === 'FAILED').length;
        lines.push(
          `- ${kb.name}（id=${kb.id}）｜处理中 ${pending}｜失败 ${failed}`,
        );
      }
    }

    if (recentFailedRuns.length > 0) {
      lines.push('', '⚠️ 最近失败的工作流运行：');
      for (const run of recentFailedRuns) {
        lines.push(
          `- ${run.workflow.name}｜${run.createdAt.toISOString()}｜${
            run.errorCode ? `[${run.errorCode}] ` : ''
          }${(run.errorMessage ?? '').slice(0, 120)}`,
        );
      }
    }

    if (brokenMcp.length > 0) {
      lines.push(
        '',
        `⚠️ 连接异常的 MCP Server：${brokenMcp.map((s) => s.name).join('、')}`,
      );
    }

    if (operationStats.length > 0) {
      lines.push(
        '',
        `平台操作记录：${operationStats
          .map((s) => `${s.status} ${s._count._all}`)
          .join('｜')}`,
      );
    }

    return {
      text: lines.join('\n'),
      targetType: 'platform',
      summary: `平台总览（工作空间 ${workspaces.length}｜工作流 ${workflowTotal}｜知识库 ${knowledgeBases.length}｜Agent ${agentCount}）`,
    };
  }
}
