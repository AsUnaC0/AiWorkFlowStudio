import { Injectable, BadRequestException } from '@nestjs/common';
import {
  NodeExecutor,
  NodeExecutionContext,
  NodeExecutionResult,
} from '../node-executor.interface';
import { VariableService } from '../variable.service';

/** 支持的运算符 */
export type ConditionOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'not_contains'
  | 'is_empty'
  | 'is_not_empty';

/** 单条条件规则 */
export interface ConditionRule {
  id: string;
  left: string;
  operator: ConditionOperator;
  right?: unknown;
}

/** Condition 节点配置 */
export interface ConditionNodeConfig {
  conditions: ConditionRule[];
  logicalOperator: 'AND' | 'OR';
}

/** 运算符中文映射（前端显示用） */
export const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  eq: '等于 (==)',
  neq: '不等于 (!=)',
  gt: '大于 (>)',
  gte: '大于等于 (>=)',
  lt: '小于 (<)',
  lte: '小于等于 (<=)',
  contains: '包含',
  not_contains: '不包含',
  is_empty: '为空',
  is_not_empty: '不为空',
};

const VALID_OPERATORS: ConditionOperator[] = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'not_contains',
  'is_empty',
  'is_not_empty',
];

@Injectable()
export class ConditionNodeExecutor implements NodeExecutor {
  constructor(private readonly variableService: VariableService) {}

  async execute(
    context: NodeExecutionContext,
    node: any,
  ): Promise<NodeExecutionResult> {
    const rawConfig = (node.config ?? {}) as ConditionNodeConfig;

    // 1. 校验配置
    this.validateConfig(rawConfig);

    // 2. 逐条评估条件，收集调试信息
    const debugInfo: Array<{
      ruleId: string;
      leftRaw: unknown;
      leftResolved: unknown;
      operator: ConditionOperator;
      rightRaw: unknown;
      rightResolved: unknown;
      result: boolean;
    }> = [];

    const results = rawConfig.conditions.map((rule) => {
      const leftResolved = this.variableService.resolve(rule.left, context);
      const rightResolved = this.variableService.resolve(rule.right, context);

      const boolResult = this.evaluate(
        leftResolved,
        rule.operator,
        rightResolved,
      );

      debugInfo.push({
        ruleId: rule.id,
        leftRaw: rule.left,
        leftResolved,
        operator: rule.operator,
        rightRaw: rule.right,
        rightResolved,
        result: boolResult,
      });

      return boolResult;
    });

    // 3. 根据逻辑运算符合并
    const matched =
      rawConfig.logicalOperator === 'AND'
        ? results.every(Boolean)
        : results.some(Boolean);

    const branch = matched ? 'true' : 'false';

    console.log(`[Condition] ${node.id} 判断结果: ${matched} → branch=${branch}`);
    console.log(`[Condition] 详情: ${JSON.stringify(debugInfo, null, 2)}`);

    return {
      output: matched,
      branch,
      metadata: {
        conditions: debugInfo,
        logicalOperator: rawConfig.logicalOperator,
      },
    };
  }

  /**
   * 校验配置完整性
   */
  private validateConfig(config: ConditionNodeConfig): void {
    if (!config.conditions || !Array.isArray(config.conditions)) {
      throw new BadRequestException('Condition 节点配置缺少 conditions 数组');
    }

    if (config.conditions.length === 0) {
      throw new BadRequestException('Condition 节点至少需要 1 条条件规则');
    }

    for (const rule of config.conditions) {
      if (!rule.left || typeof rule.left !== 'string') {
        throw new BadRequestException('Condition 条件 left 不能为空');
      }

      if (!VALID_OPERATORS.includes(rule.operator)) {
        throw new BadRequestException(
          `Condition 不支持的运算符: ${rule.operator}。支持: ${VALID_OPERATORS.join(', ')}`,
        );
      }

      // is_empty / is_not_empty 不需要 right
      if (
        rule.operator !== 'is_empty' &&
        rule.operator !== 'is_not_empty' &&
        (rule.right === undefined || rule.right === null)
      ) {
        throw new BadRequestException(
          `Condition 条件 [${rule.operator}] 需要提供 right 值`,
        );
      }
    }
  }

  /**
   * 核心条件判断器
   */
  private evaluate(
    left: unknown,
    operator: ConditionOperator,
    right: unknown,
  ): boolean {
    switch (operator) {
      case 'eq':
        return this.strictEquals(left, right);

      case 'neq':
        return !this.strictEquals(left, right);

      case 'gt':
        return this.compareNumbers(left, right, (a, b) => a > b);

      case 'gte':
        return this.compareNumbers(left, right, (a, b) => a >= b);

      case 'lt':
        return this.compareNumbers(left, right, (a, b) => a < b);

      case 'lte':
        return this.compareNumbers(left, right, (a, b) => a <= b);

      case 'contains':
        return this.doContains(left, right);

      case 'not_contains':
        return !this.doContains(left, right);

      case 'is_empty':
        return this.isEmpty(left);

      case 'is_not_empty':
        return !this.isEmpty(left);

      default:
        return false;
    }
  }

  /**
   * 严格相等比较（处理 number/string 类型自动转换）
   */
  private strictEquals(left: unknown, right: unknown): boolean {
    // 同为数字
    if (typeof left === 'number' && typeof right === 'number') {
      return left === right;
    }

    // 数字 vs 字符串数字 → 尝试转换
    if (
      typeof left === 'number' &&
      typeof right === 'string' &&
      !isNaN(Number(right))
    ) {
      return left === Number(right);
    }
    if (
      typeof right === 'number' &&
      typeof left === 'string' &&
      !isNaN(Number(left))
    ) {
      return Number(left) === right;
    }

    // 同为布尔
    if (typeof left === 'boolean' && typeof right === 'boolean') {
      return left === right;
    }

    // 同为字符串
    if (typeof left === 'string' && typeof right === 'string') {
      return left === right;
    }

    // null / undefined
    if (left === null || left === undefined) {
      return right === null || right === undefined;
    }

    return false;
  }

  /**
   * 数值比较
   */
  private compareNumbers(
    left: unknown,
    right: unknown,
    comparator: (a: number, b: number) => boolean,
  ): boolean {
    const a = this.toNumber(left);
    const b = this.toNumber(right);

    if (a === null || b === null) {
      return false;
    }

    return comparator(a, b);
  }

  /**
   * 尝试把任意值转为数字
   */
  private toNumber(value: unknown): number | null {
    if (typeof value === 'number') return value;

    if (typeof value === 'string') {
      const n = Number(value);
      return isNaN(n) ? null : n;
    }

    if (typeof value === 'boolean') return value ? 1 : 0;

    return null;
  }

  /**
   * contains 实现：left 包含 right
   * - string: 子串匹配
   * - array: 元素匹配
   */
  private doContains(left: unknown, right: unknown): boolean {
    if (left === null || left === undefined) return false;

    // 字符串包含
    if (typeof left === 'string') {
      const needle = String(right ?? '');
      return left.includes(needle);
    }

    // 数组包含
    if (Array.isArray(left)) {
      return left.some((item) => this.strictEquals(item, right));
    }

    return false;
  }

  /**
   * is_empty 实现
   */
  private isEmpty(value: unknown): boolean {
    if (value === null || value === undefined) return true;

    if (typeof value === 'string') return value.trim() === '';

    if (Array.isArray(value)) return value.length === 0;

    if (typeof value === 'object') {
      return Object.keys(value as Record<string, unknown>).length === 0;
    }

    return false;
  }
}
