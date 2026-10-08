import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkflowEngine } from '../../workflows/engine/workflow.engine';
import type { ToolContext } from './agent-tool.interface';
import type { ToolDefinition } from '../../ai/ai-provider.interface';

/**
 * WorkflowTool —— Agent 通过它调用已发布的 Workflow。
 *
 * 设计要点：
 *   - 只读 publishedVersion 的 definition，不碰 currentVersion
 *   - 保证 Agent 调用的是稳定版本（v1 / v2 / ...）
 *   - 工作流名称从 DB 读出来作为 description，让 LLM 知道这个工具是干嘛的
 *
 * 注意：它不 implements AgentTool，因为 definition 是动态生成的
 * （每个已发布工作流对应一个独立工具），没有单一静态 definition。
 */
@Injectable()
export class WorkflowTool {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: WorkflowEngine,
  ) {}

  /**
   * 根据 Agent 绑定的 workflowIds 动态生成 ToolDefinition 数组。
   * 每个已发布工作流 → 一个独立工具，工具名 = `workflow_{workflowId}`
   *
   * AgentService 在构建时会调用这个方法拿到所有工具的 definition。
   */
  async buildDefinitions(workflowIds: string[]): Promise<ToolDefinition[]> {
    if (workflowIds.length === 0) return [];

    const workflows = await this.prisma.workflow.findMany({
      where: {
        id: { in: workflowIds },
        status: 'PUBLISHED',
      },
      select: {
        id: true,
        name: true,
        description: true,
        publishedVersion: { select: { version: true } },
      },
    });

    return workflows.map((wf) => ({
      type: 'function',
      function: {
        name: `workflow_${wf.id}`,
        description: [
          `调用工作流「${wf.name}」（已发布 v${wf.publishedVersion?.version ?? 1}）`,
          wf.description ? `用途：${wf.description}` : undefined,
        ]
          .filter(Boolean)
          .join('。'),
        parameters: {
          type: 'object',
          properties: {
            input: {
              type: 'string',
              description: '传给工作流的输入内容（自然语言 / JSON 字符串都可）',
            },
          },
          required: ['input'],
        },
      },
    }));
  }

  /** 执行工作流 —— 从函数名里解析 workflowId，读 publishedVersion，跑引擎 */
  async execute(
    args: Record<string, unknown>,
    context: ToolContext & { workflowId?: string },
  ): Promise<string> {
    // 优先用 context 里传的 workflowId（AgentService 解析 toolCall.function.name 后塞进来）
    const workflowId = context.workflowId;
    if (!workflowId) {
      throw new Error('WorkflowTool.execute 缺少 workflowId');
    }

    const workflow = await this.prisma.workflow.findUnique({
      where: { id: workflowId },
      select: {
        id: true,
        name: true,
        status: true,
        publishedVersion: {
          select: { id: true, definition: true, version: true },
        },
      },
    });

    if (!workflow) {
      throw new Error(`工作流不存在: ${workflowId}`);
    }
    if (workflow.status !== 'PUBLISHED') {
      throw new Error(
        `工作流「${workflow.name}」尚未发布，Agent 只能调用已发布版本`,
      );
    }
    if (!workflow.publishedVersion) {
      throw new Error(`工作流「${workflow.name}」没有已发布版本`);
    }

    const input = String(args.input ?? '');
    console.log(
      `[WorkflowTool] 调用 ${workflow.name} (v${workflow.publishedVersion.version}) input=`,
      input,
    );

    const result = await this.engine.run(
      workflow.publishedVersion.definition,
      input,
    );

    // 工作流输出 = context.previousOutput（Output 节点的产物）
    const output =
      typeof result.previousOutput === 'string'
        ? result.previousOutput
        : JSON.stringify(result.previousOutput ?? result.data, null, 2);

    console.log(`[WorkflowTool] ${workflow.name} 输出长度: ${output.length}`);

    return `工作流「${workflow.name}」(v${workflow.publishedVersion.version}) 运行结果：\n${output}`;
  }
}
