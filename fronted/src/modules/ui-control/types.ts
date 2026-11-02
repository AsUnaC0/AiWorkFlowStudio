/**
 * UI Control —— 类型定义。
 *
 * 设计原则（对应需求文档「建立 UI Action Registry」）：
 *   1. 大模型**永远不操作 DOM、不生成 JS**，只能调用这里预先注册的语义化操作。
 *   2. 每个操作都声明所属页面（pageId），页面不在当前路由时可以先跳转。
 *   3. 操作返回结构化结果，由聊天层回传给后端，后端再喂回模型 —— 不假设成功。
 */

export type UIActionCategory =
  | "navigation"
  | "click"
  | "dialog"
  | "form"
  | "scroll"
  | "wait";

export type UIActionRisk = "LOW" | "MEDIUM" | "HIGH";

/** 一个可被 AI 调用的界面操作（元信息） */
export interface UIActionDescriptor {
  /** 语义化操作名，必须全局唯一 */
  name: string;
  /** 中文展示名（操作卡片标题） */
  label: string;
  /** 给模型看的说明 */
  description: string;
  category: UIActionCategory;
  risk?: UIActionRisk;
  /** 归属页面：操作不在当前页时，执行器会先跳转过去 */
  pageId?: string;
}

/** 操作执行结果 */
export interface UIActionResult {
  success: boolean;
  message: string;
  /** 执行后的当前路由 */
  currentRoute?: string;
  /** 执行后的页面 id（skills / mcp / …） */
  currentPage?: string;
  /**
   * 真实页面状态快照。
   *
   * 只凭「函数返回成功」不能算成功 —— 路由守卫可能把用户重定向到登录页，
   * 弹窗也可能没真正打开。这里回传能观察到的状态（dialogVisible 等），
   * 让后端/模型判断的是真实页面，而不是函数调用。
   */
  actualState?: Record<string, unknown>;
  /** 结构化错误码（NOT_REGISTERED / PAGE_NOT_READY / ROUTE_MISMATCH …） */
  errorCode?: string;
  /** 结构化错误信息 */
  errorMessage?: string;
  data?: Record<string, unknown>;
}

/** 页面注册的实际执行函数（拿到的是操作参数） */
export type UIActionHandler = (
  params: Record<string, unknown>,
) => Promise<UIActionResult> | UIActionResult;

/** 页面声明的一个可执行操作 */
export interface PageActionDescriptor {
  name: string;
  label: string;
  description?: string;
}

/** 页面在挂载时向 UI Control 注册的上下文 */
export interface PageContextRegistration {
  pageId: string;
  title: string;
  route: string;
  description?: string;
  /** 该页面可执行的语义化操作 */
  actions?: PageActionDescriptor[];
}

/** 随聊天请求上报给后端的「当前页面上下文」 */
export interface UIContextPayload {
  pageId?: string;
  title?: string;
  route?: string;
  description?: string;
  availableActions?: Array<{
    name: string;
    label?: string;
    description?: string;
  }>;
  openDialog?: string;
}
