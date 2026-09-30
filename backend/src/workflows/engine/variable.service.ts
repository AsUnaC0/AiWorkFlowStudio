import { Injectable } from '@nestjs/common';
import { NodeExecutionContext } from './node-executor.interface';

/**
 * 变量服务：统一解析 Workflow 中的 {{variable}} 模板
 *
 * 支持的变量格式：
 * - {{input}}                 → 工作流初始输入
 * - {{previous}}              → 上一个节点的输出
 * - {{nodeId.output}}         → 指定节点的输出
 * - {{nodeId.output.field}}   → 指定节点输出的某个字段（支持嵌套）
 * - {{http_1.body.userId}}    → HTTP 节点 body 中的 userId
 * - {{http_1.status}}         → HTTP 节点的状态码
 */
@Injectable()
export class VariableService {
  private static readonly VARIABLE_REGEX = /\{\{\s*([^{}]+?)\s*\}\}/g;

  /**
   * 解析模板中的所有 {{variable}} 引用 — 保持原始类型
   * 整个模板如果是单个 {{xxx}}，返回 lookupVariable 的原始值（number / boolean / object / array）
   * 否则返回字符串拼接结果
   */
  resolve(template: unknown, context: NodeExecutionContext): unknown {
    if (template === null || template === undefined) {
      return template;
    }

    if (typeof template === 'string') {
      return this.resolveStringRaw(template, context);
    }

    if (Array.isArray(template)) {
      return template.map((item) => this.resolve(item, context));
    }

    if (typeof template === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(template)) {
        result[key] = this.resolve(value, context);
      }
      return result;
    }

    // number, boolean 等基本类型直接返回
    return template;
  }

  /**
   * 向后兼容：多变量模板替换时强制字符串化（HTTP URL / Prompt 场景用）
   */
  resolveAsString(template: unknown, context: NodeExecutionContext): string {
    const resolved = this.resolve(template, context);
    if (resolved === null || resolved === undefined) return '';
    if (typeof resolved === 'string') return resolved;
    return JSON.stringify(resolved);
  }

  /**
   * 解析字符串变量，保持原始类型
   * 单个变量引用 → 返回原始值（number / boolean / object / array）
   * 多变量模板 → 返回字符串拼接结果
   */
  private resolveStringRaw(
    template: string,
    context: NodeExecutionContext,
  ): unknown {
    // 先检查整个字符串是否就是单个变量引用
    const fullMatch = template.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
    if (fullMatch) {
      const resolved = this.lookupVariable(fullMatch[1].trim(), context);
      return resolved; // 直接返回，不做 JSON.stringify
    }

    // 多变量模板 → 字符串替换
    return template.replace(
      VariableService.VARIABLE_REGEX,
      (_match, varPath) => {
        const resolved = this.lookupVariable(varPath.trim(), context);
        if (resolved === undefined || resolved === null) {
          return '';
        }
        if (typeof resolved === 'object') {
          return JSON.stringify(resolved);
        }
        return String(resolved);
      },
    );
  }

  /**
   * 根据变量路径查找值
   * 路径格式：input / previous / nodeId / nodeId.body.xxx
   */
  lookupVariable(path: string, context: NodeExecutionContext): unknown {
    const parts = path.split('.');
    const rootKey = parts[0];

    let rootValue: unknown;

    if (rootKey === 'input') {
      rootValue = context.input;
    } else if (rootKey === 'previous' || rootKey === 'output') {
      // {{previous}} / {{output}} 都指向上一个节点输出
      rootValue = context.previousOutput;
    } else {
      // 从 context.data 中查找对应节点的输出
      rootValue = context.data?.[rootKey];
    }

    if (rootValue === undefined || rootValue === null) {
      return undefined;
    }

    // 如果只有一段（如 {{input}} 或 {{http_1}}），直接返回根值
    if (parts.length === 1) {
      return rootValue;
    }

    // 否则按路径深入查找（如 {{http_1.body.userId}}）
    return this.deepLookup(rootValue, parts.slice(1));
  }

  /**
   * 在对象中按路径深入查找值
   * 例如 deepLookup({ body: { userId: 1 } }, ['body', 'userId']) → 1
   */
  private deepLookup(obj: unknown, pathParts: string[]): unknown {
    let current = obj;

    for (const part of pathParts) {
      if (current === null || current === undefined) {
        return undefined;
      }

      if (typeof current !== 'object') {
        return undefined;
      }

      current = (current as Record<string, unknown>)[part];
    }

    return current;
  }
}

