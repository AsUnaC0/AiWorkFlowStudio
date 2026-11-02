import type {
  PageContextRegistration,
  UIActionDescriptor,
  UIActionHandler,
} from "./types";

/**
 * UIActionRegistry —— 界面操作注册中心。
 *
 * 三份数据：
 *   - descriptors：所有「语义化操作」的元信息（navigate / open_dialog / …），
 *     静态注册，用于校验与展示。
 *   - pageContexts：每个页面在挂载时上报的上下文（页面名、路由、可用操作）。
 *   - pageHandlers：页面挂载时注册的**实际执行函数**。
 *
 * 为什么 handler 由页面动态注册，而不是写在静态 actions 文件里：
 *   打开弹窗依赖组件内部的响应式状态（`ref` / 组件作用域函数）。
 *   让页面把自己的 `openCreateDialog` 注册进来，既不需要重构弹窗状态，
 *   也不用 AI 去找 DOM 元素 —— 仍然是语义化调用。
 *
 * 关键约束：`resolveHandler` **只查当前激活页面**的 handler，
 * 避免「用户已经离开 Skill 页，却还能触发它的弹窗」。
 */
class UIActionRegistry {
  private readonly descriptors = new Map<string, UIActionDescriptor>();
  private readonly pageContexts = new Map<string, PageContextRegistration>();
  private readonly pageHandlers = new Map<string, Map<string, UIActionHandler>>();
  private activePageId: string | null = null;

  // -------------------------------------------------------------------------
  // 操作元信息
  // -------------------------------------------------------------------------

  registerDescriptors(list: UIActionDescriptor[]): void {
    for (const d of list) this.descriptors.set(d.name, d);
  }

  getDescriptor(name: string): UIActionDescriptor | undefined {
    return this.descriptors.get(name);
  }

  listDescriptors(): UIActionDescriptor[] {
    return [...this.descriptors.values()];
  }

  // -------------------------------------------------------------------------
  // 页面上下文 / 执行函数
  // -------------------------------------------------------------------------

  registerPageContext(ctx: PageContextRegistration): void {
    this.pageContexts.set(ctx.pageId, ctx);
  }

  registerPageHandlers(
    pageId: string,
    handlers: Record<string, UIActionHandler>,
  ): void {
    const map = this.pageHandlers.get(pageId) ?? new Map();
    for (const [name, handler] of Object.entries(handlers)) {
      map.set(name, handler);
    }
    this.pageHandlers.set(pageId, map);
  }

  /** 页面卸载时清理，避免离开后仍能触发它的操作 */
  unregisterPage(pageId: string): void {
    this.pageContexts.delete(pageId);
    this.pageHandlers.delete(pageId);
    // activePageId 由路由 afterEach 维护，这里不动
  }

  setActivePage(pageId: string | null): void {
    this.activePageId = pageId;
  }

  getActivePageId(): string | null {
    return this.activePageId;
  }

  getPageContext(pageId: string): PageContextRegistration | undefined {
    return this.pageContexts.get(pageId);
  }

  getActivePageContext(): PageContextRegistration | null {
    if (!this.activePageId) return null;
    return this.pageContexts.get(this.activePageId) ?? null;
  }

  listPageContexts(): Array<[string, PageContextRegistration]> {
    return [...this.pageContexts.entries()];
  }

  /**
   * 解析操作执行函数 —— **只查当前激活页面**。
   * 返回 null 表示「当前页面没有这个操作」（可能还没挂载完，或不属于该页）。
   */
  resolveHandler(
    name: string,
  ): { handler: UIActionHandler; pageId: string } | null {
    if (!this.activePageId) return null;
    const handler = this.pageHandlers.get(this.activePageId)?.get(name);
    if (!handler) return null;
    return { handler, pageId: this.activePageId };
  }

  /** 某个页面是否声明了该操作（用于「先跳转再执行」） */
  hasActionOnPage(pageId: string, name: string): boolean {
    const ctx = this.pageContexts.get(pageId);
    if (ctx?.actions?.some((a) => a.name === name)) return true;
    return this.pageHandlers.get(pageId)?.has(name) ?? false;
  }
}

export const uiActionRegistry = new UIActionRegistry();
