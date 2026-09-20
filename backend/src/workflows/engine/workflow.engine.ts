import { Injectable } from '@nestjs/common';
import { NodeExecutorRegistry } from './node-executor.registry';
import { LLMNodeExecutor } from './executors/llm.executor';

export type WorkflowStreamEvent =
  | { type: 'node:start'; nodeId: string; nodeType: string; label?: string }
  | { type: 'token'; nodeId: string; content: string }
  | { type: 'node:complete'; nodeId: string; nodeType: string; output: unknown }
  | { type: 'complete'; data: Record<string, unknown> }
  | { type: 'error'; message: string };

@Injectable()
export class WorkflowEngine {
  constructor(private readonly registry: NodeExecutorRegistry) {}

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

      const result = await executor.execute(context, currentNode);

      context.data[currentNode.id] = result.output;
      context.previousOutput = result.output;

      const outgoingEdges = workflow.edges.filter(
        (edge: any) => edge.source === currentNode.id,
      );

      const nextNodeType = outgoingEdges[0]
        ? workflow.nodes.find((n: any) => n.id === outgoingEdges[0].target)
            ?.type
        : 'end';

      console.log(
        `[Node: ${currentNode.type}] 执行完成 → 传给下一个节点 [${nextNodeType}] 的输入:`,
        context.previousOutput,
      );

      if (outgoingEdges.length === 0) {
        break;
      }

      if (outgoingEdges.length > 1) {
        throw new Error(`Node ${currentNode.id} 存在多个后继节点`);
      }

      const edge = outgoingEdges[0];

      currentNode = workflow.nodes.find((node: any) => node.id === edge.target);

      if (!currentNode) {
        throw new Error(`找不到目标 Node: ${edge.target}`);
      }
    }

    return context;
  }

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

      let output: unknown = '';
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
        output = streamedOutput;
      } else {
        const result = await executor.execute(context, currentNode);
        output = result.output;
      }

      context.data[currentNode.id] = output;
      context.previousOutput = output;
      yield { type: 'node:complete', nodeId: currentNode.id, nodeType, output };

      const outgoingEdges = workflow.edges.filter(
        (edge: any) => edge.source === currentNode.id,
      );

      const nextNodeType = outgoingEdges[0]
        ? workflow.nodes.find((n: any) => n.id === outgoingEdges[0].target)
            ?.type
        : 'end';

      console.log(
        `[Stream][Node: ${nodeType}] 执行完成 → 传给下一个节点 [${nextNodeType}] 的输入:`,
        context.previousOutput,
      );

      if (outgoingEdges.length === 0) break;
      if (outgoingEdges.length > 1) {
        throw new Error(`Node ${currentNode.id} 存在多个后继节点`);
      }

      currentNode = workflow.nodes.find(
        (node: any) => node.id === outgoingEdges[0].target,
      );
      if (!currentNode)
        throw new Error(`找不到目标 Node: ${outgoingEdges[0].target}`);
    }

    yield { type: 'complete', data: context.data };
  }
}
