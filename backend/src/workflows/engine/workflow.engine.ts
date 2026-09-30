import { Injectable } from '@nestjs/common';
import { NodeExecutorRegistry } from './node-executor.registry';
import { LLMNodeExecutor } from './executors/llm.executor';
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

@Injectable()
export class WorkflowEngine {
  constructor(private readonly registry: NodeExecutorRegistry) {}

  // ================== 普通运行 ==================
  async run(workflow: any, input: unknown) {
    const context = {
      input,
      data: {},
      previousOutput: input,
    };

    let currentNode = workflow.nodes.find((node: any) => node.type === 'start');
    if (!currentNode) {
      throw new Error('Workflow 缺少 Start Node');
    }

    const visitedNodeIds = new Set<string>();

    while (currentNode) {
      if (visitedNodeIds.has(currentNode.id)) {
        throw new Error(`Workflow 存在循环: ${currentNode.id}`);
      }
      visitedNodeIds.add(currentNode.id);

      const executor = this.registry.get(currentNode.type);
      const result: NodeExecutionResult = await executor.execute(
        context,
        currentNode,
      );

      // Condition 节点存完整调试信息；其它节点仅存 output
      context.data[currentNode.id] = result.branch
        ? {
            result: result.output,
            branch: result.branch,
            metadata: result.metadata,
          }
        : result.output;

      context.previousOutput = result.output;

      const outgoingEdges = workflow.edges.filter(
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

      const nextNode = workflow.nodes.find(
        (node: any) => node.id === targetEdge.target,
      );

      if (!nextNode) {
        throw new Error(`找不到目标 Node: ${targetEdge.target}`);
      }

      console.log(
        `[Node: ${currentNode.type}] → [Node: ${nextNode.type}]${result.branch ? ` (branch=${result.branch})` : ''}`,
      );

      currentNode = nextNode;
    }

    return context;
  }

  // ================== 流式运行 ==================
  async *runStream(
    workflow: any,
    input: unknown,
  ): AsyncGenerator<WorkflowStreamEvent> {
    const context = { input, data: {}, previousOutput: input };
    let currentNode = workflow.nodes.find((node: any) => node.type === 'start');

    if (!currentNode) throw new Error('Workflow 缺少 Start Node');

    const visitedNodeIds = new Set<string>();

    while (currentNode) {
      if (visitedNodeIds.has(currentNode.id)) {
        throw new Error(`Workflow 存在循环: ${currentNode.id}`);
      }
      visitedNodeIds.add(currentNode.id);

      const nodeType = currentNode.type;

      yield {
        type: 'node:start',
        nodeId: currentNode.id,
        nodeType,
        label: currentNode.data?.label,
      };

      let result: NodeExecutionResult;
      const executor = this.registry.get(nodeType);

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

      const outgoingEdges = workflow.edges.filter(
        (edge: any) => edge.source === currentNode.id,
      );

      if (outgoingEdges.length === 0) break;

      const targetEdge = this.pickNextEdge(outgoingEdges, result);

      if (!targetEdge) {
        throw new Error(
          `Node ${currentNode.id} 无法选择后继边（outgoing=${outgoingEdges.length}, branch=${result.branch ?? 'none'}）`,
        );
      }

      currentNode = workflow.nodes.find(
        (node: any) => node.id === targetEdge.target,
      );

      if (!currentNode) {
        throw new Error(`找不到目标 Node: ${targetEdge.target}`);
      }
    }

    yield { type: 'complete', data: context.data };
  }

  // ================== 内部辅助 ==================

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
