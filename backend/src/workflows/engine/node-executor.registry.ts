import { Injectable } from '@nestjs/common';
import { NodeExecutor } from './node-executor.interface';
import { InputNodeExecutor } from './executors/input.executor';
import { LLMNodeExecutor } from './executors/llm.executor';
import { OutputNodeExecutor } from './executors/output.executor';
import { StartNodeExecutor } from './executors/start.executor';
import { PromptNodeExecutor } from './executors/prompt.executor';

@Injectable()
export class NodeExecutorRegistry {
  private readonly executors = new Map<string, NodeExecutor>();

  constructor(
    private readonly startExecutor: StartNodeExecutor,
    private readonly inputExecutor: InputNodeExecutor,
    private readonly llmExecutor: LLMNodeExecutor,
    private readonly outputExecutor: OutputNodeExecutor,
    private readonly promptExecutor: PromptNodeExecutor,
  ) {
    this.executors.set('start', startExecutor);
    this.executors.set('input', inputExecutor);
    this.executors.set('llm', llmExecutor);
    this.executors.set('output', outputExecutor);
    this.executors.set('prompt', promptExecutor);
  }

  get(type: string): NodeExecutor {
    const executor = this.executors.get(type);

    if (!executor) {
      throw new Error(`没有找到 Node Executor: ${type}`);
    }

    return executor;
  }
}
