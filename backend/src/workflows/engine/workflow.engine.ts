import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NodeExecutorRegistry } from './node-executor.registry';
import { LLMNodeExecutor } from './executors/llm.executor';
import { RunMonitorService } from './run-monitor.service';
import type { NodeExecutionResult } from './node-executor.interface';

export type WorkflowStreamEvent =
  | { type: 'node:start'; nodeId: string; nodeType: string; label?: string }
  | { type: 'token'; nodeId: string; content: string }
  | {
      type: 'node:complete';
      nodeId: string;
      nodeType: string;
      output: unknown;
      branch?: string;
      metadata?: Record<string, unknown>;
    }
  | { type: 'complete'; data: Record<string, unknown> }
  | { type: 'error'; message: string };

/** 运行选项：传 runId 才会持久化 NodeRun；否则只输出控制台日志 */
export interface RunOptions {
  runId?: string;
  workflowId?: string;
}

@Injectable()
export class WorkflowEngine {
  constructor(
    private readonly registry: NodeExecutorRegistry,
    private readonly prisma: PrismaService,
    private readonly monitor: RunMonitorService,
  ) {}

  /**
   * 把 DB/画布传来的 definition 统一成引擎可执行的格式。
   * VueFlow 画布上所有节点 node.type 都是 "custom"，真正的语义类型存在 data.nodeType 里；
   * 而 SSE 路径会前端手动把 data.nodeType 提升到 node.type。
   * 这里统一归一化，保证两条链路行为一致。
   */
  private normalizeWorkflow(workflow: any): any {
    return {
      nodes: workflow.nodes.map((node: any) => ({
        ...node,
        // 优先取已提升的 type，否则从 data.nodeType 回退
        type:
          node.type && node.type !== 'custom'
            ? node.type
            : (node.data?.nodeType ?? node.type),
        // 执行器从 node.config 读取配置；SSE 路径前端已设 config，
        // BullMQ 路径从 DB 加载只有 node.data → 补映射
        config: node.config ?? { ...node.data },
      })),
      edges: workflow.edges,
    };
  }

  // ================== 普通运行 ==================
  async run(workflow: any, input: unknown, options: RunOptions = {}) {
    const runId = options.runId ?? null;
    const workflowId = options.workflowId;
    const normalized = this.normalizeWorkflow(workflow);
    const runStart = Date.now();

    this.monitor.logRunStart(runId, workflowId ?? 'unknown');

    const context = {
      input,
      data: {},
      previousOutput: input,
    };

    let currentNode = normalized.nodes.find(
      (node: any) => node.type === 'start',
    );
    if (!currentNode) {
      throw new Error('Workflow 缺少 Start Node');
    }

    const visitedNodeIds = new Set<string>();

    while (currentNode) {
      if (visitedNodeIds.has(currentNode.id)) {
        throw new Error(`Workflow 存在循环: ${currentNode.id}`);
      }
      visitedNodeIds.add(currentNode.id);

      const result = await this.executeNode(currentNode, context, runId);

      const outgoingEdges = normalized.edges.filter(
        (edge: any) => edge.source === currentNode.id,
      );

      // 没后继 → 结束
      if (outgoingEdges.length === 0) break;

      // 核心：根据 result.branch 决定走哪条边
      const targetEdge = this.pickNextEdge(outgoingEdges, result);

      if (!targetEdge) {
        throw new Error(
          `Node ${currentNode.id} 无法选择后继边（outgoing=${outgoingEdges.length}, branch=${result.branch ?? 'none'}）`,
        );
      }

      const nextNode = normalized.nodes.find(
        (node: any) => node.id === targetEdge.target,
      );

      if (!nextNode) {
        throw new Error(`找不到目标 Node: ${targetEdge.target}`);
      }

      currentNode = nextNode;
    }

    const totalMs = Date.now() - runStart;
    this.monitor.logRunComplete(runId, totalMs);

    return context;
  }

  // ================== 流式运行 ==================
  async *runStream(
    workflow: any,
    input: unknown,
    options: RunOptions = {},
  ): AsyncGenerator<WorkflowStreamEvent> {
    const runId = options.runId ?? null;
    const workflowId = options.workflowId;
    const normalized = this.normalizeWorkflow(workflow);
    const context = { input, data: {}, previousOutput: input };
    const runStart = Date.now();

    this.monitor.logRunStart(runId, workflowId ?? 'unknown');

    let currentNode = normalized.nodes.find(
      (node: any) => node.type === 'start',
    );

    if (!currentNode) throw new Error('Workflow 缺少 Start Node');

    const visitedNodeIds = new Set<string>();

    while (currentNode) {
      if (visitedNodeIds.has(currentNode.id)) {
        throw new Error(`Workflow 存在循环: ${currentNode.id}`);
      }
      visitedNodeIds.add(currentNode.id);

      const nodeType = currentNode.type;
      const label = currentNode.data?.label;

      yield {
        type: 'node:start',
        nodeId: currentNode.id,
        nodeType,
        label,
      };

      // 创建 NodeRun (RUNNING)
      const nodeStart = Date.now();
      let nodeRunId: string | null = null;
      if (runId) {
        const nodeRun = await this.prisma.workflowNodeRun.create({
          data: {
            runId,
            nodeId: currentNode.id,
            nodeType,
            label: label ?? null,
            status: 'RUNNING',
            startedAt: new Date(),
            input: this.safeJson(context.previousOutput ?? context.input),
          },
        });
        nodeRunId = nodeRun.id;
      }

      this.monitor.logNodeStart(runId, nodeType, currentNode.id, label);

      let result: NodeExecutionResult;
      const executor = this.registry.get(nodeType);

      try {
        if (executor instanceof LLMNodeExecutor) {
          let streamedOutput = '';
          for await (const chunk of executor.executeStream(
            context,
            currentNode,
          )) {
            streamedOutput += chunk;
            yield { type: 'token', nodeId: currentNode.id, content: chunk };
          }
          result = { output: streamedOutput };
        } else {
          result = await executor.execute(context, currentNode);
        }

        const durationMs = Date.now() - nodeStart;

        // 更新 NodeRun → SUCCESS
        if (nodeRunId) {
          await this.prisma.workflowNodeRun.update({
            where: { id: nodeRunId },
            data: {
              status: 'SUCCESS',
              output: this.safeJson(result.output),
              branch: result.branch ?? null,
              metadata: this.safeJson(result.metadata),
              endedAt: new Date(),
              durationMs,
            },
          });
        }

        this.monitor.logNodeComplete(
          runId,
          nodeType,
          currentNode.id,
          durationMs,
          result.branch,
        );
      } catch (error) {
        const durationMs = Date.now() - nodeStart;
        const message = error instanceof Error ? error.message : String(error);

        if (nodeRunId) {
          await this.prisma.workflowNodeRun.update({
            where: { id: nodeRunId },
            data: {
              status: 'FAILED',
              errorMessage: message,
              endedAt: new Date(),
              durationMs,
            },
          });
        }

        this.monitor.logNodeFailed(
          runId,
          nodeType,
          currentNode.id,
          durationMs,
          message,
        );
        throw error;
      }

      // 存储结果
      context.data[currentNode.id] = result.branch
        ? {
            result: result.output,
            branch: result.branch,
            metadata: result.metadata,
          }
        : result.output;

      context.previousOutput = result.output;

      yield {
        type: 'node:complete',
        nodeId: currentNode.id,
        nodeType,
        output: result.output,
        branch: result.branch,
        metadata: result.metadata,
      };

      const outgoingEdges = normalized.edges.filter(
        (edge: any) => edge.source === currentNode.id,
      );

      if (outgoingEdges.length === 0) break;

      const targetEdge = this.pickNextEdge(outgoingEdges, result);

      if (!targetEdge) {
        throw new Error(
          `Node ${currentNode.id} 无法选择后继边（outgoing=${outgoingEdges.length}, branch=${result.branch ?? 'none'}）`,
        );
      }

      currentNode = normalized.nodes.find(
        (node: any) => node.id === targetEdge.target,
      );

      if (!currentNode) {
        throw new Error(`找不到目标 Node: ${targetEdge.target}`);
      }
    }

    const totalMs = Date.now() - runStart;
    this.monitor.logRunComplete(runId, totalMs);

    yield { type: 'complete', data: context.data };
  }

  // ================== 内部辅助 ==================

  /**
   * 执行单个节点，并记录 NodeRun + 监控日志。
   * 失败时更新 FAILED 并 rethrow。
   */
  private async executeNode(
    currentNode: any,
    context: {
      input: unknown;
      data: Record<string, unknown>;
      previousOutput?: unknown;
    },
    runId: string | null,
  ): Promise<NodeExecutionResult> {
    const executor = this.registry.get(currentNode.type);
    const nodeStart = Date.now();
    const label = currentNode.data?.label;
    const nodeType = currentNode.type;

    this.monitor.logNodeStart(runId, nodeType, currentNode.id, label);

    // 创建 NodeRun (RUNNING)
    let nodeRunId: string | null = null;
    if (runId) {
      const nodeRun = await this.prisma.workflowNodeRun.create({
        data: {
          runId,
          nodeId: currentNode.id,
          nodeType,
          label: label ?? null,
          status: 'RUNNING',
          startedAt: new Date(),
          input: this.safeJson(context.previousOutput ?? context.input),
        },
      });
      nodeRunId = nodeRun.id;
    }

    try {
      const result: NodeExecutionResult = await executor.execute(
        context,
        currentNode,
      );

      const durationMs = Date.now() - nodeStart;

      // 更新 NodeRun → SUCCESS
      if (nodeRunId) {
        await this.prisma.workflowNodeRun.update({
          where: { id: nodeRunId },
          data: {
            status: 'SUCCESS',
            output: this.safeJson(result.output),
            branch: result.branch ?? null,
            metadata: this.safeJson(result.metadata),
            endedAt: new Date(),
            durationMs,
          },
        });
      }

      this.monitor.logNodeComplete(
        runId,
        nodeType,
        currentNode.id,
        durationMs,
        result.branch,
      );

      return result;
    } catch (error) {
      const durationMs = Date.now() - nodeStart;
      const message = error instanceof Error ? error.message : String(error);

      if (nodeRunId) {
        await this.prisma.workflowNodeRun.update({
          where: { id: nodeRunId },
          data: {
            status: 'FAILED',
            errorMessage: message,
            endedAt: new Date(),
            durationMs,
          },
        });
      }

      this.monitor.logNodeFailed(
        runId,
        nodeType,
        currentNode.id,
        durationMs,
        message,
      );
      throw error;
    }
  }

  /**
   * 把任意值安全序列化为 Prisma JSON 输入。
   * - undefined → JsonNull（避免 Prisma 报错）
   * - 含循环引用/bigint → JsonNull（兜底）
   * - 其他 → 原值（Prisma 接受 JSON 兼容类型）
   *
   * 返回类型用 any 规避 Prisma JSON 输入类型的联合纠缠
   * （NullableJsonInput = InputJsonValue | JsonNullValue | DbNullValue | null）
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private safeJson(value: unknown): any {
    if (value === undefined) return Prisma.JsonNull;
    try {
      // 用 JSON 往返确保可序列化（处理 bigint / 循环引用）
      return JSON.parse(JSON.stringify(value));
    } catch {
      return Prisma.JsonNull;
    }
  }

  /**
   * 根据 NodeExecutionResult 选择下一条 Edge
   *
   * 策略：
   * 1. result.branch 存在（Condition/Switch）→ 用 sourceHandle === branch 匹配
   * 2. 无 branch（普通节点）
   *    - 恰好 1 条 → 直接用
   *    - 多条且有唯一不带 sourceHandle 的边 → 用那条
   *    - 其它情况 → 抛错
   */
  private pickNextEdge(
    outgoingEdges: any[],
    result: NodeExecutionResult,
  ): any | null {
    // 有 branch → 按 sourceHandle 匹配
    if (result.branch) {
      const matched = outgoingEdges.find(
        (e) => e.sourceHandle === result.branch,
      );

      if (matched) return matched;

      // 防御：部分历史数据可能用 '-true' / '-false' 后缀
      const fallback = outgoingEdges.find(
        (e) =>
          e.sourceHandle === `${result.branch}` ||
          e.sourceHandle === `source-${result.branch}`,
      );

      return fallback ?? null;
    }

    // 无 branch → 普通节点
    if (outgoingEdges.length === 1) {
      return outgoingEdges[0];
    }

    // 多条：尝试找不带 sourceHandle 的边
    const noHandle = outgoingEdges.find(
      (e) => !e.sourceHandle || e.sourceHandle === '',
    );
    if (noHandle && outgoingEdges.filter((e) => !e.sourceHandle).length === 1) {
      return noHandle;
    }

    throw new Error(
      `普通节点不能有多个带 sourceHandle 的后继边；请确认是否应该使用 Condition 节点`,
    );
  }
}
