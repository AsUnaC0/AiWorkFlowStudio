import type { Router } from "vue-router";

/**
 * UI Control 的运行时引用。
 *
 * 这里刻意不在模块顶层 import `@/router` —— 那会形成
 * `router → 页面 → ui-control → router` 的循环引用。
 * 改为由 `installUIControl(router)` 在应用启动时注入实例。
 */
let routerRef: Router | null = null;

export function setUIRouter(router: Router): void {
  routerRef = router;
}

export function getUIRouter(): Router {
  if (!routerRef) {
    throw new Error("UI Control 尚未初始化（未调用 installUIControl）");
  }
  return routerRef;
}
