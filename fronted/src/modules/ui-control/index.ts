import type { Router } from "vue-router";
import { uiActionRegistry } from "./registry";
import { ROUTE_PAGE_MAP } from "./page-catalog";
import { setUIRouter } from "./runtime";
import { navigationActions } from "./actions/navigation.actions";
import { commonActions } from "./actions/common.actions";

// 对外出口：页面与聊天层只需要从这里 import
export type {
  UIActionCategory,
  UIActionDescriptor,
  UIActionHandler,
  UIActionResult,
  UIActionRisk,
  PageActionDescriptor,
  PageContextRegistration,
  UIContextPayload,
} from "./types";

export { uiActionRegistry } from "./registry";
export { executeUIAction, enqueueUIAction } from "./executor";
export { getCurrentUIContext } from "./context";
export { getBrowserSessionId } from "./session";
export {
  startUICommandBridge,
  stopUICommandBridge,
} from "./browser-bridge";
export {
  registerPageContext,
  unregisterPageContext,
} from "./page-registration";

/**
 * 安装 UI Control（应用启动时调用一次）。
 *
 * 做两件事：
 *   1. 注册内置的通用操作元信息（navigate / open_dialog / click_action / fill_form）
 *   2. 监听路由变化，维护「当前激活页面」——执行器据此只允许操作当前页
 */
export function installUIControl(router: Router): void {
  setUIRouter(router);

  uiActionRegistry.registerDescriptors([
    ...navigationActions,
    ...commonActions,
  ]);

  const syncActivePage = (route: { name?: unknown }): void => {
    const pageId = ROUTE_PAGE_MAP[String(route.name ?? "")] ?? null;
    uiActionRegistry.setActivePage(pageId);
  };

  syncActivePage(router.currentRoute.value);
  router.afterEach((to) => {
    syncActivePage(to);
  });
}
