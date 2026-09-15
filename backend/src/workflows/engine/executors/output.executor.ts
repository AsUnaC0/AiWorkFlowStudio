import { Injectable } from '@nestjs/common';

import {
  NodeExecutor,
  NodeExecutionContext,
  NodeExecutionResult,
} from '../node-executor.interface';

@Injectable()
export class OutputNodeExecutor implements NodeExecutor {
  async execute(
    context: NodeExecutionContext,
    node: any,
  ): Promise<NodeExecutionResult> {
    console.log('执行 Output Node');

    return {
      output: context.previousOutput ?? context.input,
    };
  }
}
