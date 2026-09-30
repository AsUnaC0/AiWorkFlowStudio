import { Injectable } from '@nestjs/common';

import {
  NodeExecutor,
  NodeExecutionContext,
  NodeExecutionResult,
} from '../node-executor.interface';
import { VariableService } from '../variable.service';

@Injectable()
export class PromptNodeExecutor implements NodeExecutor {
  constructor(private readonly variableService: VariableService) {}

  execute(
    context: NodeExecutionContext,
    node: any,
  ): Promise<NodeExecutionResult> {
    const template = String(node.config?.prompt ?? '');

    // previousOutput 可能是对象（如 HTTP 输出），需要妥善处理
    const rawInput = context.previousOutput ?? context.input ?? '';
    const stringify = (val: unknown): string =>
      val === null || val === undefined
        ? ''
        : typeof val === 'string'
          ? val
          : typeof val === 'object'
            ? JSON.stringify(val)
            : String(val);
    const previousOutput = stringify(rawInput);

    // 1. 先检测原模板里是否有任何 {{变量}} 引用
    const HAS_VARIABLE_REGEX = /\{\{\s*[^{}]+\s*\}\}/;
    const hasVariables = HAS_VARIABLE_REGEX.test(template);

    // 2. 用 VariableService 统一解析所有变量
    const resolved = String(
      this.variableService.resolve(template, context) ?? '',
    );

    let output: string;

    if (hasVariables) {
      // 模板中有 {{变量}} —— 完全由变量解析结果决定
      output = resolved;
    } else {
      // 模板中没有 {{变量}} —— 保留历史 fallback：追加 previousOutput
      // 这样旧工作流里 "prompt: 请分析以下内容" 不会丢失输入
      output = resolved ? `${resolved}\n${previousOutput}` : previousOutput;
    }

    return Promise.resolve({ output });
  }
}
