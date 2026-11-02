/**
 * UI Control（界面操作）相关的共享类型。
 *
 * 这一层与「业务平台工具」的区别：
 *   - PlatformTool（create_skill / create_workflow …）直接操作**业务数据**
 *   - UI Action（navigate / open_dialog / click …）只操作**界面**：
 *     跳转页面、打开弹窗、填写表单，不写任何业务数据
 *
 * 执行方在前端（Vue Router + Pinia / 组件状态），后端只负责：
 *   1. 把「允许的界面操作」以工具形式暴露给 LLM
 *   2. 把 LLM 的意图翻译成结构化指令，经 SSE 推给前端
 *   3. 等待前端回传真实执行结果（不是假设成功）
 *
 * 因此这里刻意**不包含**任何 DOM / CSS 选择器 / 坐标信息 ——
 * 模型永远拿不到「点哪里」，只能拿到语义化操作名。
 */

/** 一次界面操作指令（后端 → 前端） */
export interface UIActionInstruction {
  /** 语义化操作名，必须在前端 UI Action Registry 注册过 */
  name: string;
  /** 操作参数（页面 id / 弹窗 id / 表单字段 …） */
  params?: Record<string, unknown>;
}

/**
 * 指令生命周期状态。
 *
 *   pending   —— 已创建，尚未被浏览器领取（桌宠发起时在队列里）
 *   delivered —— 已交给某个浏览器会话
 *   executing —— 前端已开始执行（可选上报）
 *   success   —— 执行成功
 *   failed    —— 执行失败（含页面未响应 / 校验不通过）
 *   expired   —— 过期未领取或执行超时
 *   cancelled —— 用户主动取消
 */
export type UICommandStatus =
  | 'pending'
  | 'delivered'
  | 'executing'
  | 'success'
  | 'failed'
  | 'expired'
  | 'cancelled';

/**
 * 前端回传的执行结果。
 *
 * 与前端 `UIActionResult` 对齐，但只保留后端需要关心的字段。
 * 关键：`success` 之外还要带「真实页面状态」，避免
 * 「函数返回 true 但路由被守卫重定向 / 弹窗没真正打开」被当成成功。
 */
export interface UIActionResultPayload {
  success: boolean;
  message: string;
  /** 执行后的当前路由（便于后端记录与模型判断） */
  currentRoute?: string;
  /** 执行后的当前页面 id（skills / mcp / …） */
  currentPage?: string;
  /** 真实页面状态快照（dialogVisible / selectedTab / loading …） */
  actualState?: Record<string, unknown>;
  /** 结构化错误码（TIMEOUT / NOT_REGISTERED / PAGE_NOT_READY …） */
  errorCode?: string;
  /** 结构化错误信息 */
  errorMessage?: string;
  /** 是否因「用户取消」而终止 */
  cancelled?: boolean;
  /** 可选的结构化补充数据 */
  data?: Record<string, unknown>;
}

/** 前端随聊天请求上报的「当前页面上下文」 */
export interface UIContextPayload {
  /** 页面标识，如 skills / mcp / agents */
  pageId?: string;
  /** 页面标题（中文展示名） */
  title?: string;
  /** 当前路由，如 /skills */
  route?: string;
  /** 页面用途简述 */
  description?: string;
  /** 当前页面可执行的语义化操作 */
  availableActions?: Array<{
    name: string;
    label?: string;
    description?: string;
  }>;
  /** 当前打开的弹窗标识（可选） */
  openDialog?: string;
}

/**
 * 下发给浏览器的指令（线上格式）。
 *
 * 与内部 `UICommand` 的区别：**不含 userId**（不把归属信息发到前端），
 * 只带前端执行需要的字段。
 */
export interface UICommandWire {
  commandId: string;
  taskId?: string;
  /** 语义化操作名：navigate / open_dialog / click_action / fill_form */
  name: string;
  params?: Record<string, unknown>;
  /** 触发这条指令的平台工具名（调试用） */
  tool?: string;
  /** 中文展示名，桌面端可以直接拿去显示 */
  label?: string;
  status: UICommandStatus;
  createdAt: number;
  expiresAt: number;
  retryCount: number;
}

/** 浏览器会话摘要（给「选择目标标签页」等界面用） */
export interface UIBrowserSessionSummary {
  sessionId: string;
  status: 'online' | 'offline';
  /** 最近一次有效活动时间（轮询 / 上报 / 结果回传） */
  lastActivityAt: number;
  /** 最近上报的页面上下文 */
  pageId?: string;
  route?: string;
  title?: string;
  openDialog?: string;
  /** 队列里还没被领取的指令数 */
  queued: number;
}
