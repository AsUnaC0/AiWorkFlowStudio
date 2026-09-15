import { Injectable } from '@nestjs/common';

import {
  NodeExecutor,
  NodeExecutionContext,
  NodeExecutionResult,
} from '../node-executor.interface';

@Injectable()
export class InputNodeExecutor implements NodeExecutor {

  async execute(
    context: NodeExecutionContext,
    node: any,
  ): Promise<NodeExecutionResult> {

    console.log('执行 Input Node');

    return {
      output: context.input,
    };
  }
}