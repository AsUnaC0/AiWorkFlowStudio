import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkflowsService } from '../../workflows/workflows.service';
import { LlmConfigService } from '../../llm-config/llm-config.service';
import type {
  PlatformTool,
  PlatformToolContext,
  PlatformToolOutcome,
} from '../platform-tool.interface';
import {
  asInt,
  asOptionalString,
  asRecord,
  asString,
} from '../platform-tool.interface';
import {
  WORKFLOW_NODE_LABELS,
  WORKFLOW_NODE_REQUIRED_CONFIG,
  WORKFLOW_NODE_TYPES,
  normalizeWorkflowDefinition,
  summarizeWorkflowDefinition,
  validateWorkflowDefinition,
  workflowEditorLink,
  type WorkflowDefinitionLike,
} from '../workflow-definition.util';

/**
 * 工作流相关平台工具。
 *
 * 设计要点（对应「生成草稿 → 校验 → 展示 → 用户确认 → 保存」流程）：
 *   - `validate_workflow` 独立暴露，让模型可以先自检再提交
 *   - `create_workflow_draft` 内部**强制再跑一次校验**，不通过就不落库
 *   - 落库一律走 `WorkflowsService.create`（复用工作空间成员校验 + 版本表）
 *   - 发布是 HIGH 风险动作，单独成工具，便于后续加二次确认
 */
@Injectable()
export class WorkflowTools {
  private readonly logger = new Logger(WorkflowTools.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly workflowsService: WorkflowsService,
    private readonly llmConfigService: LlmConfigService,
  ) {}

  readonly tools: PlatformTool[] = [
    {
      name: 'list_workflows',
      meta: {
        label: '查询工作流',
        action: 'QUERY',
        riskLevel: 'LOW',
        targetType: 'workflow',
      },
      definition: {
        type: 'function',
        function: {
          name: 'list_workflows',
          description:
            '查询当前用户可访问的工作流列表（含状态、已发布版本、最近一次运行结果）。' +
            '支持按工作空间、状态、名称关键字筛选。',
          parameters: {
            type: 'object',
            properties: {
              workspaceId: {
                type: 'string',
                description: '可选：限定某个工作空间（不传则查全部可访问空间）',
              },
              status: {
                type: 'string',
                enum: ['DRAFT', 'PUBLISHED', 'ARCHIVED'],
                description: '可选：按状态筛选',
              },
              keyword: {
                type: 'string',
                description: '可选：按工作流名称模糊筛选',
              },
            },
          },
        },
      },
      execute: (args, ctx) => this.listWorkflows(args, ctx),
    },

    {
      name: 'get_workflow_run_history',
      meta: {
        label: '查询运行记录',
        action: 'QUERY',
        riskLevel: 'LOW',
        targetType: 'workflow',
      },
      definition: {
        type: 'function',
        function: {
          name: 'get_workflow_run_history',
          description:
            '查询工作流的运行记录与失败原因。' +
            '当用户问「哪些工作流运行失败了」「为什么失败」时使用。' +
            '不传 workflowId 时，会跨所有可访问工作流查询最近的运行记录。',
          parameters: {
            type: 'object',
            properties: {
              workflowId: {
                type: 'string',
                description: '可选：只看某个工作流的运行记录',
              },
              onlyFailed: {
                type: 'boolean',
                description: '可选：只返回失败（FAILED）的运行，默认 false',
              },
              limit: {
                type: 'integer',
                description: '返回条数，默认 10，最大 50',
              },
            },
          },
        },
      },
      execute: (args, ctx) => this.getRunHistory(args, ctx),
    },

    {
      name: 'validate_workflow',
      meta: {
        label: '校验工作流定义',
        action: 'QUERY',
        riskLevel: 'LOW',
        targetType: 'workflow',
      },
      definition: {
        type: 'function',
        function: {
          name: 'validate_workflow',
          description:
            '校验一份工作流定义是否合法（节点类型、必填配置、连线、可达性、是否有环、引用的知识库/模型是否有权限）。' +
            '在调用 create_workflow_draft 之前先用它自检，可以避免保存失败。' +
            '不会写入任何数据。',
          parameters: {
            type: 'object',
            properties: {
              nodes: {
                type: 'array',
                description:
                  '节点数组。每项形如 {"id":"llm-1","data":{"nodeType":"llm","label":"LLM","prompt":"...","model":"qwen2.5:7b"}}',
                items: { type: 'object' },
              },
              edges: {
                type: 'array',
                description:
                  '连线数组。每项形如 {"id":"e1","source":"start-1","target":"llm-1"}',
                items: { type: 'object' },
              },
            },
            required: ['nodes', 'edges'],
          },
        },
      },
      execute: (args, ctx) => this.validateWorkflow(args, ctx),
    },

    {
      name: 'create_workflow_draft',
      meta: {
        label: '创建工作流草稿',
        action: 'CREATE',
        riskLevel: 'MEDIUM',
        targetType: 'workflow',
      },
      definition: {
        type: 'function',
        function: {
          name: 'create_workflow_draft',
          description: [
            '把生成好的节点与连线保存为一个新的工作流草稿（DRAFT，不发布）。',
            '保存前会自动再校验一次；校验不通过会返回具体错误，不会写库。',
            '返回工作流 id 与编辑器链接，用户可点击进入画布继续调整。',
            '',
            `可用 nodeType：${WORKFLOW_NODE_TYPES.join(' / ')}`,
            `各类型必填配置：${Object.entries(WORKFLOW_NODE_REQUIRED_CONFIG)
              .map(([t, fields]) =>
                fields.length ? `${t}→${fields.join('+')}` : `${t}→无`,
              )
              .join('；')}`,
            '',
            '节点 id 建议用「类型-序号」形式（如 start-1 / llm-1 / output-1）。',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: '工作流名称',
              },
              description: {
                type: 'string',
                description: '可选：工作流用途说明',
              },
              workspaceId: {
                type: 'string',
                description:
                  '可选：目标工作空间 id。不传则用当前工作空间；若用户有多个空间且未指定，应先询问用户',
              },
              nodes: {
                type: 'array',
                description:
                  '节点数组。必须包含恰好一个 data.nodeType="start" 的起点',
                items: { type: 'object' },
              },
              edges: {
                type: 'array',
                description: '连线数组',
                items: { type: 'object' },
              },
            },
            required: ['name', 'nodes', 'edges'],
          },
        },
      },
      execute: (args, ctx) => this.createDraft(args, ctx),
    },

    {
      name: 'publish_workflow',
      meta: {
        label: '发布工作流',
        action: 'EXECUTE',
        riskLevel: 'HIGH',
        targetType: 'workflow',
      },
      definition: {
        type: 'function',
        function: {
          name: 'publish_workflow',
          description:
            '把工作流的当前草稿版本发布为稳定版本（发布后 Agent 才能调用它）。' +
            '这是高影响操作：执行前必须先向用户确认工作流名称，得到明确同意后再调用。',
          parameters: {
            type: 'object',
            properties: {
              workflowId: {
                type: 'string',
                description: '要发布的工作流 id',
              },
            },
            required: ['workflowId'],
          },
        },
      },
      execute: (args, ctx) => this.publishWorkflow(args, ctx),
    },

    {
      name: 'run_workflow',
      meta: {
        label: '执行工作流',
        action: 'EXECUTE',
        riskLevel: 'MEDIUM',
        targetType: 'workflow',
      },
      definition: {
        type: 'function',
        function: {
          name: 'run_workflow',
          description:
            '异步触发一次已发布工作流的运行（进入后台队列，立即返回 runId）。' +
            '返回后可用 get_workflow_run_history 查询运行结果。',
          parameters: {
            type: 'object',
            properties: {
              workflowId: {
                type: 'string',
                description: '要运行的工作流 id（必须已发布）',
              },
              input: {
                type: 'string',
                description: '传给工作流的输入内容',
              },
            },
            required: ['workflowId'],
          },
        },
      },
      execute: (args, ctx) => this.runWorkflow(args, ctx),
    },
  ];

  // =========================================================================
  // 实现
  // =========================================================================

  /** 当前用户可访问的工作空间 ID 列表 */
  private async accessibleWorkspaceIds(userId: string): Promise<string[]> {
    const list = await this.prisma.workspace.findMany({
      where: {
        OR: [{ ownerId: userId }, { members: { some: { userId } } }],
      },
      select: { id: true },
    });
    return list.map((w) => w.id);
  }

  /**
   * 解析目标工作空间：
   *   1. 模型显式传入 → 必须在用户可访问范围内（否则拒绝）
   *   2. 否则用当前上下文空间
   *   3. 否则回退用户第一个空间
   * 三者都拿不到 → 返回 null，由调用方提示用户
   */
  private async resolveWorkspaceId(
    args: Record<string, unknown>,
    ctx: PlatformToolContext,
  ): Promise<{ workspaceId?: string; error?: string }> {
    const requested = asOptionalString(args.workspaceId);

    if (requested) {
      if (!ctx.accessibleWorkspaceIds.includes(requested)) {
        return {
          error: `工作空间 ${requested} 不存在或当前用户无权访问。请先调用 list_workspaces 确认。`,
        };
      }
      return { workspaceId: requested };
    }

    if (
      ctx.workspaceId &&
      ctx.accessibleWorkspaceIds.includes(ctx.workspaceId)
    ) {
      return { workspaceId: ctx.workspaceId };
    }

    const first = await this.prisma.workspace.findFirst({
      where: {
        OR: [
          { ownerId: ctx.userId },
          { members: { some: { userId: ctx.userId } } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    if (!first) {
      return {
        error:
          '当前用户还没有任何工作空间，无法创建工作流。请先在工作空间页面创建一个工作空间。',
      };
    }
    return { workspaceId: first.id };
  }

  private async listWorkflows(
    args: Record<string, unknown>,
    ctx: PlatformToolContext,
  ): Promise<PlatformToolOutcome> {
    const status = asOptionalString(args.status);
    const keyword = asOptionalString(args.keyword);
    const workspaceId = asOptionalString(args.workspaceId);

    if (workspaceId && !ctx.accessibleWorkspaceIds.includes(workspaceId)) {
      return {
        text: `错误：工作空间 ${workspaceId} 不存在或无权访问。`,
        status: 'DENIED',
        summary: '无权访问该工作空间',
      };
    }

    const workflows = await this.prisma.workflow.findMany({
      where: {
        workspaceId: workspaceId
          ? workspaceId
          : { in: ctx.accessibleWorkspaceIds },
        ...(status ? { status } : {}),
        ...(keyword
          ? { name: { contains: keyword, mode: 'insensitive' } }
          : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: {
        id: true,
        name: true,
        description: true,
        status: true,
        updatedAt: true,
        workspace: { select: { id: true, name: true } },
        publishedVersion: { select: { version: true } },
        runs: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { status: true, createdAt: true, errorMessage: true },
        },
      },
    });

    if (workflows.length === 0) {
      return {
        text: '没有符合条件的工作流。',
        targetType: 'workflow',
        summary: '查询工作流（0 个）',
      };
    }

    const lines = workflows.map((wf) => {
      const lastRun = wf.runs[0];
      const runInfo = lastRun
        ? `｜最近运行=${lastRun.status}${lastRun.errorMessage ? `（${lastRun.errorMessage.slice(0, 60)}）` : ''}`
        : '｜最近运行=无';
      return [
        `- ${wf.name}｜id=${wf.id}`,
        `  空间=${wf.workspace?.name ?? '-'}｜状态=${wf.status}｜已发布版本=${
          wf.publishedVersion ? `v${wf.publishedVersion.version}` : '未发布'
        }${runInfo}`,
        wf.description ? `  说明=${wf.description}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    });

    return {
      text: `共 ${workflows.length} 个工作流：\n${lines.join('\n')}`,
      targetType: 'workflow',
      summary: `查询工作流（${workflows.length} 个）`,
    };
  }

  private async getRunHistory(
    args: Record<string, unknown>,
    ctx: PlatformToolContext,
  ): Promise<PlatformToolOutcome> {
    const workflowId = asOptionalString(args.workflowId);
    const onlyFailed = args.onlyFailed === true || args.onlyFailed === 'true';
    const limit = Math.min(Math.max(asInt(args.limit, 10), 1), 50);

    const runs = await this.prisma.workflowRun.findMany({
      where: {
        ...(workflowId ? { workflowId } : {}),
        ...(onlyFailed ? { status: 'FAILED' } : {}),
        workflow: {
          workspace: {
            OR: [
              { ownerId: ctx.userId },
              { members: { some: { userId: ctx.userId } } },
            ],
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        status: true,
        errorCode: true,
        errorMessage: true,
        durationMs: true,
        triggerType: true,
        createdAt: true,
        completedAt: true,
        workflow: {
          select: {
            id: true,
            name: true,
            workspace: { select: { name: true } },
          },
        },
        nodeRuns: {
          where: { status: 'FAILED' },
          select: {
            nodeId: true,
            nodeType: true,
            label: true,
            errorMessage: true,
          },
          take: 3,
        },
      },
    });

    if (runs.length === 0) {
      return {
        text: onlyFailed
          ? '没有查询到失败的运行记录。'
          : '没有查询到运行记录。',
        targetType: 'workflow',
        targetId: workflowId,
        summary: '查询运行记录（0 条）',
      };
    }

    const lines = runs.map((run) => {
      const failedNodes = run.nodeRuns
        .map(
          (n) =>
            `    · 节点「${n.label || n.nodeType}」(${n.nodeId})：${n.errorMessage ?? '无错误信息'}`,
        )
        .join('\n');
      return [
        `- [${run.status}] ${run.workflow.name}｜runId=${run.id}`,
        `  时间=${run.createdAt.toISOString()}｜触发=${run.triggerType}｜耗时=${
          run.durationMs ?? '-'
        }ms`,
        run.errorCode || run.errorMessage
          ? `  错误：${run.errorCode ? `[${run.errorCode}] ` : ''}${run.errorMessage ?? ''}`
          : '',
        failedNodes,
      ]
        .filter(Boolean)
        .join('\n');
    });

    const failedCount = runs.filter((r) => r.status === 'FAILED').length;

    return {
      text: [
        `查询到 ${runs.length} 条运行记录（其中失败 ${failedCount} 条）：`,
        ...lines,
      ].join('\n'),
      targetType: 'workflow',
      targetId: workflowId,
      summary: `查询运行记录（${runs.length} 条，失败 ${failedCount} 条）`,
    };
  }

  private async validateWorkflow(
    args: Record<string, unknown>,
    ctx: PlatformToolContext,
  ): Promise<PlatformToolOutcome> {
    const definition = this.readDefinition(args);
    if (!definition) {
      return {
        text: '错误：需要同时提供 nodes 与 edges 数组。',
        status: 'FAILED',
        summary: '入参不完整',
      };
    }

    const [ownedKnowledgeBaseIds, ownedLlmModelIds] = await Promise.all([
      this.ownedKnowledgeBaseIds(ctx.userId),
      this.ownedLlmModelIds(ctx.userId),
    ]);

    const result = validateWorkflowDefinition(definition, {
      ownedKnowledgeBaseIds,
      ownedLlmModelIds,
    });

    const lines = [
      result.valid ? '✅ 校验通过' : '❌ 校验未通过',
      `结构：${result.summary.flow}`,
      `节点数=${result.summary.nodeCount}，连线数=${result.summary.edgeCount}`,
    ];
    if (result.errors.length) {
      lines.push(
        '',
        '错误（必须修复）：',
        ...result.errors.map((e) => `- ${e}`),
      );
    }
    if (result.warnings.length) {
      lines.push(
        '',
        '提示（可选优化）：',
        ...result.warnings.map((w) => `- ${w}`),
      );
    }

    return {
      text: lines.join('\n'),
      status: result.valid ? 'SUCCESS' : 'FAILED',
      targetType: 'workflow',
      summary: result.valid
        ? `工作流定义校验通过（${result.summary.nodeCount} 节点）`
        : `工作流定义校验未通过（${result.errors.length} 个错误）`,
    };
  }

  private async createDraft(
    args: Record<string, unknown>,
    ctx: PlatformToolContext,
  ): Promise<PlatformToolOutcome> {
    const name = asString(args.name);
    if (!name) {
      return {
        text: '错误：name 不能为空。',
        status: 'FAILED',
        summary: '缺少工作流名称',
      };
    }

    const definition = this.readDefinition(args);
    if (!definition) {
      return {
        text: '错误：需要同时提供 nodes 与 edges 数组。',
        status: 'FAILED',
        summary: '入参不完整',
      };
    }

    const { workspaceId, error } = await this.resolveWorkspaceId(args, ctx);
    if (!workspaceId) {
      return {
        text: `错误：${error}`,
        status: 'DENIED',
        summary: '无法确定目标工作空间',
      };
    }

    // 落库前强制校验 —— 模型生成的 JSON 不允许绕过
    const [ownedKnowledgeBaseIds, ownedLlmModelIds] = await Promise.all([
      this.ownedKnowledgeBaseIds(ctx.userId),
      this.ownedLlmModelIds(ctx.userId),
    ]);
    const validation = validateWorkflowDefinition(definition, {
      ownedKnowledgeBaseIds,
      ownedLlmModelIds,
    });
    if (!validation.valid) {
      return {
        text: [
          '❌ 工作流定义校验未通过，**没有创建任何数据**。请修正后重新调用：',
          ...validation.errors.map((e) => `- ${e}`),
        ].join('\n'),
        status: 'FAILED',
        targetType: 'workflow',
        targetName: name,
        summary: `创建工作流失败：${validation.errors.length} 个校验错误`,
      };
    }

    const normalized = normalizeWorkflowDefinition(definition);

    const workflow = await this.workflowsService.create(
      ctx.userId,
      workspaceId,
      {
        name,
        description: asOptionalString(args.description),
        definition: normalized as unknown as Record<string, unknown>,
      },
    );

    const summary = summarizeWorkflowDefinition(normalized);

    this.logger.log(
      `平台助理为用户 ${ctx.userId} 创建工作流草稿 ${workflow.id}（${name}）`,
    );

    return {
      text: [
        `✅ 已创建工作流草稿「${name}」（id=${workflow.id}）`,
        `执行路径：${summary.flow}`,
        `节点 ${summary.nodeCount} 个，连线 ${summary.edgeCount} 条`,
        `编辑器链接：${workflowEditorLink(workflow.id)}`,
        '',
        '当前为 DRAFT 状态，还需要发布（publish_workflow）后 Agent 才能调用。',
      ].join('\n'),
      targetType: 'workflow',
      targetId: workflow.id,
      targetName: name,
      summary: `创建工作流草稿「${name}」（${summary.nodeCount} 节点）`,
      link: workflowEditorLink(workflow.id),
    };
  }

  private async publishWorkflow(
    args: Record<string, unknown>,
    ctx: PlatformToolContext,
  ): Promise<PlatformToolOutcome> {
    const workflowId = asString(args.workflowId);
    if (!workflowId) {
      return {
        text: '错误：workflowId 不能为空。',
        status: 'FAILED',
        summary: '缺少 workflowId',
      };
    }

    try {
      const workflow = await this.workflowsService.publish(
        ctx.userId,
        workflowId,
      );
      return {
        text: [
          `✅ 已发布工作流「${workflow.name}」`,
          `已发布版本：v${workflow.publishedVersion?.version ?? '?'}`,
          `编辑器链接：${workflowEditorLink(workflow.id)}`,
        ].join('\n'),
        targetType: 'workflow',
        targetId: workflow.id,
        targetName: workflow.name,
        summary: `发布工作流「${workflow.name}」`,
        link: workflowEditorLink(workflow.id),
      };
    } catch (err) {
      return {
        text: `发布失败：${err instanceof Error ? err.message : String(err)}`,
        status: 'FAILED',
        targetType: 'workflow',
        targetId: workflowId,
        summary: '发布工作流失败',
      };
    }
  }

  private async runWorkflow(
    args: Record<string, unknown>,
    ctx: PlatformToolContext,
  ): Promise<PlatformToolOutcome> {
    const workflowId = asString(args.workflowId);
    if (!workflowId) {
      return {
        text: '错误：workflowId 不能为空。',
        status: 'FAILED',
        summary: '缺少 workflowId',
      };
    }

    const workflow = await this.prisma.workflow.findFirst({
      where: {
        id: workflowId,
        workspaceId: { in: ctx.accessibleWorkspaceIds },
      },
      select: { id: true, name: true, status: true },
    });
    if (!workflow) {
      return {
        text: `错误：工作流 ${workflowId} 不存在或无权访问。`,
        status: 'DENIED',
        summary: '无权访问该工作流',
      };
    }
    if (workflow.status !== 'PUBLISHED') {
      return {
        text: `错误：工作流「${workflow.name}」当前状态为 ${workflow.status}，只有已发布的工作流才能运行。`,
        status: 'FAILED',
        targetType: 'workflow',
        targetId: workflow.id,
        targetName: workflow.name,
        summary: '工作流未发布，无法运行',
      };
    }

    const run = await this.workflowsService.enqueueRun(
      ctx.userId,
      workflowId,
      asString(args.input),
    );

    return {
      text: [
        `✅ 已提交运行「${workflow.name}」，runId=${run.id}`,
        '运行在后台队列执行，稍后可用 get_workflow_run_history 查询结果。',
      ].join('\n'),
      targetType: 'workflow',
      targetId: workflow.id,
      targetName: workflow.name,
      summary: `触发工作流「${workflow.name}」运行（runId=${run.id}）`,
      link: workflowEditorLink(workflow.id),
    };
  }

  // =========================================================================
  // 辅助
  // =========================================================================

  /** 从入参里读 nodes / edges，兼容模型把它们序列化成 JSON 字符串 */
  private readDefinition(
    args: Record<string, unknown>,
  ): WorkflowDefinitionLike | null {
    const nodes = this.asArray(args.nodes);
    const edges = this.asArray(args.edges);
    if (!nodes || !edges) return null;
    return {
      nodes: nodes as WorkflowDefinitionLike['nodes'],
      edges: edges as WorkflowDefinitionLike['edges'],
    };
  }

  private asArray(value: unknown): unknown[] | null {
    if (Array.isArray(value)) return value as unknown[];
    if (typeof value === 'string' && value.trim().startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(value);
        if (Array.isArray(parsed)) return parsed as unknown[];
      } catch {
        return null;
      }
    }
    // 兼容 { nodes: [...] } 这种多包一层的形态
    const record = asRecord(value);
    if (record) {
      const inner = record.nodes ?? record.edges;
      if (Array.isArray(inner)) return inner as unknown[];
    }
    return null;
  }

  private async ownedKnowledgeBaseIds(userId: string): Promise<string[]> {
    const list = await this.prisma.knowledgeBase.findMany({
      where: { ownerId: userId },
      select: { id: true },
    });
    return list.map((k) => k.id);
  }

  private async ownedLlmModelIds(userId: string): Promise<string[]> {
    try {
      return await this.llmConfigService.listOwnedModelIds(userId);
    } catch {
      return [];
    }
  }

  /** 供 Prompt 使用：节点能力清单 */
  static nodeCapabilityText(): string {
    return WORKFLOW_NODE_TYPES.map((type) => {
      const required = WORKFLOW_NODE_REQUIRED_CONFIG[type] ?? [];
      return `- ${type}（${WORKFLOW_NODE_LABELS[type]}）${
        required.length ? `必填配置：${required.join('、')}` : ''
      }`;
    }).join('\n');
  }
}
