import type { ToolDefinition } from '../ai/ai-provider.interface';
import type {
  UIActionInstruction,
  UIContextPayload,
} from './ui-action.types';

/**
 * 平台工具（Platform Tool）统一契约。
 *
 * 与 `agent/tools/agent-tool.interface.ts` 里的 AgentTool 的区别：
 *   - AgentTool 是「Agent 绑定了某个资源」后动态生成的工具（workflow_{id} / knowledge_search）
 *   - PlatformTool 是**平台内置**的固定工具，由后端注册，用户无法通过聊天消息临时定义
 *
 * 每个平台工具都必须声明自己的元信息（action / riskLevel / targetType），
 * 这些元信息不进入 LLM 上下文，只用于：
 *   1. 审计落库（PlatformOperationLog）
 *   2. 前端操作卡片渲染（风险等级徽标）
 *   3. 后续接入「高风险操作需二次确认」的授权策略
 */

/** 语义动作 */
export type PlatformToolAction =
  'QUERY' | 'CREATE' | 'UPDATE' | 'DELETE' | 'EXECUTE';

/** 风险等级（产品授权策略，非技术限制） */
export type PlatformToolRisk = 'LOW' | 'MEDIUM' | 'HIGH';

/** 操作结果 */
export type PlatformOperationStatus = 'SUCCESS' | 'FAILED' | 'DENIED';

export interface PlatformToolMeta {
  /** 面向用户的中文名，前端操作卡片直接展示 */
  label: string;
  action: PlatformToolAction;
  riskLevel: PlatformToolRisk;
  /** 默认目标资源类型：workflow / knowledge_base / document / agent / ... */
  targetType?: string;
  /**
   * 是否写入审计表（PlatformOperationLog）。默认 true。
   *
   * UI Control 工具（跳转 / 打开弹窗）只操作界面、不碰业务数据，
   * 写进「平台操作记录」只会让审计列表变成一串无意义的「打开弹窗」，
   * 因此显式关闭审计；它们仍会以 trail 步骤出现在聊天过程里。
   */
  audit?: boolean;
}

/**
 * 平台工具执行上下文。
 *
 * 关键约束：`userId` / `workspaceId` 只能来自后端已验证的认证上下文，
 * 绝不允许从模型入参（args）里读取 —— 模型无权声明"我是谁"。
 */
export interface PlatformToolContext {
  /** 来自已验证 JWT 的用户 ID */
  userId: string;
  /** 触发本次调用的 Agent ID */
  agentId: string;
  /** 当前聊天会话 ID */
  sessionId?: string;
  /** 当前工作空间（后端校验用户成员关系后的可信值） */
  workspaceId?: string;
  /** 该用户可访问的全部工作空间 ID（用于校验模型传入的 workspaceId） */
  accessibleWorkspaceIds: string[];
  /**
   * 前端上报的「当前页面上下文」（仅 UI Control 工具使用）。
   * 只用于告诉模型「用户现在在哪个页面、有哪些操作」，
   * 不参与任何权限判断 —— 权限永远以服务端认证为准。
   */
  uiContext?: UIContextPayload;
}

/** 平台工具执行结果 */
export interface PlatformToolOutcome {
  /** 喂回 LLM 的文本（模型据此继续推理 / 组织回答） */
  text: string;
  /** 覆盖默认状态（缺省 SUCCESS；抛错时由注册中心置为 FAILED） */
  status?: PlatformOperationStatus;
  targetType?: string;
  targetId?: string;
  targetName?: string;
  /** 人类可读的结果摘要（前端卡片 + 审计） */
  summary?: string;
  /** 前端可跳转的资源入口，如 /workspace/<workflowId> */
  link?: string;
  /**
   * 界面操作指令（UI Control 工具专用）。
   *
   * 有值时表示这个工具**没有在服务端执行任何业务动作**，
   * 而是要求前端执行一次界面操作。AgentService 会把它翻译成
   * `ui_action` 事件推给前端，并等待前端回传真实结果后再喂回模型。
   */
  uiAction?: UIActionInstruction;
}

export interface PlatformTool {
  /** 工具名（= definition.function.name，全局唯一） */
  readonly name: string;
  readonly meta: PlatformToolMeta;
  readonly definition: ToolDefinition;
  execute(
    args: Record<string, unknown>,
    ctx: PlatformToolContext,
  ): Promise<PlatformToolOutcome>;
}

// ---------------------------------------------------------------------------
// 入参解析小工具（LLM 经常把数字/布尔传成字符串，或把数组传成 JSON 字符串）
// ---------------------------------------------------------------------------

export function asString(value: unknown, fallback = ''): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return fallback;
}

export function asOptionalString(value: unknown): string | undefined {
  const s = asString(value);
  return s.length > 0 ? s : undefined;
}

export function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === 'string' ? v.trim() : String(v)))
      .filter((v) => v.length > 0);
  }
  if (typeof value === 'string' && value.trim()) {
    // 兼容模型把数组序列化成 "[a,b]" 或 "a,b"
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        return asStringArray(parsed);
      } catch {
        return [];
      }
    }
    return trimmed
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }
  return [];
}

export function asInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}
