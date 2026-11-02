import { uiActionRegistry } from "./registry";
import type { PageContextRegistration, UIActionHandler } from "./types";

/**
 * 页面在 `onMounted` 时调用：登记「我是谁、我能做什么、怎么做」。
 *
 * @param ctx      页面上下文（pageId / title / route / 可用操作）
 * @param handlers 操作名 → 执行函数（通常直接包一层页面内已有的 openXxxDialog）
 */
export function registerPageContext(
  ctx: PageContextRegistration,
  handlers: Record<string, UIActionHandler>,
): void {
  uiActionRegistry.registerPageContext(ctx);
  uiActionRegistry.registerPageHandlers(ctx.pageId, handlers);
}

/** 页面在 `onUnmounted` 时调用：撤销注册，避免离开后仍能触发 */
export function unregisterPageContext(pageId: string): void {
  uiActionRegistry.unregisterPage(pageId);
}
