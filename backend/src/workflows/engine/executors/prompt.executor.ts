import { Injectable } from '@nestjs/common';

import {
  NodeExecutor,
  NodeExecutionContext,
  NodeExecutionResult,
} from '../node-executor.interface';

@Injectable()
export class PromptNodeExecutor implements NodeExecutor {
  execute(
    context: NodeExecutionContext,
    node: any,
  ): Promise<NodeExecutionResult> {
    const template = String(node.config?.prompt ?? '');
    const input = String(context.previousOutput ?? context.input ?? '');

    let merged: string;

    if (template.includes('{{input}}')) {
      merged = template.replace(/\{\{\s*input\s*\}\}/g, input);
    } else {
      merged = template ? `${template}\n${input}` : input;
    }

    return Promise.resolve({
      output: merged,
    });
  }
}
