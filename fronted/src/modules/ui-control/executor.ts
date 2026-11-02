import { uiActionRegistry } from "./registry";
import { getUIRouter } from "./runtime";
import { DIALOG_ACTIONS, PAGE_CATALOG } from "./page-catalog";
import type { UIActionHandler, UIActionResult } from "./types";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 串行执行队列。
 *
 * 后端的 ReAct 循环是「发一条 ui_action → 等前端结果 → 再发下一条」，
 * 正常情况下队列里最多一条。这里再做一层串行化，防止事件密集到达时
 * 多个操作同时改路由 / 弹窗状态。
 */
let queue: Promise<unknown> = Promise.resolve();

export function enqueueUIAction<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 等待某个操作在当前页面注册完成（页面刚跳转过来时需要） */
async function waitForHandler(
  actionName: string,
  timeoutMs = 2500,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (uiActionRegistry.resolveHandler(actionName)) return true;
    await sleep(50);
  }
  return false;
}

/** 当前激活页面 id（null → undefined，便于序列化） */
function activePage(): string | undefined {
  return uiActionRegistry.getActivePageId() ?? undefined;
}

/**
 * 跳转到指定页面。
 *
 * 关键：push 之后**重新读取真实路由**再判断成功。
 * 路由守卫可能把用户重定向到登录页 —— 只看 `push()` 没抛异常就返回成功，
 * 会让模型以为页面已经打开。
 */
async function navigateTo(pageId: string): Promise<UIActionResult> {
  const page = PAGE_CATALOG[pageId];
  if (!page) {
    return {
      success: false,
      message: `未知页面：${pageId}`,
      errorCode: "UNKNOWN_PAGE",
      errorMessage: `页面 ${pageId} 不在 PAGE_CATALOG 中`,
    };
  }

  const router = getUIRouter();
  if (router.currentRoute.value.path !== page.route) {
    await router.push(page.route);
  }

  const actualPath = router.currentRoute.value.path;
  const actualRoute = router.currentRoute.value.fullPath;

  if (actualPath !== page.route) {
    return {
      success: false,
      message: `跳转被拦截，当前停在 ${actualPath}`,
      currentRoute: actualRoute,
      currentPage: activePage(),
      actualState: { expectedRoute: page.route, route: actualPath },
      errorCode: "ROUTE_MISMATCH",
      errorMessage: `期望 ${page.route}，实际 ${actualPath}`,
    };
  }

  return {
    success: true,
    message: `已打开「${page.title}」页面`,
    currentRoute: actualRoute,
    currentPage: pageId,
    actualState: { route: actualPath },
  };
}

/** 执行一个已注册的 handler，统一兜底异常并补全真实页面信息 */
async function runHandler(
  handler: UIActionHandler,
  params: Record<string, unknown>,
  label: string,
): Promise<UIActionResult> {
  try {
    const result = await handler(params);
    return {
      ...result,
      currentRoute:
        result.currentRoute ?? getUIRouter().currentRoute.value.fullPath,
      currentPage: result.currentPage ?? activePage(),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : `${label}执行失败`;
    return {
      success: false,
      message,
      currentPage: activePage(),
      errorCode: "HANDLER_ERROR",
      errorMessage: message,
    };
  }
}

/** 在所有已挂载页面里查找声明了该操作的页面（用于「先跳转再执行」） */
function findOwnerPage(actionName: string): string | null {
  for (const [pageId] of uiActionRegistry.listPageContexts()) {
    if (uiActionRegistry.hasActionOnPage(pageId, actionName)) return pageId;
  }
  return null;
}

/**
 * 执行一条界面操作指令。
 *
 * 入参就是后端 `ui_action` 事件里的 `{ name, params }`。
 * 注意这里**不做任何业务写入** —— 只切页面 / 开弹窗 / 填表。
 */
export async function executeUIAction(
  name: string,
  params: Record<string, unknown> = {},
): Promise<UIActionResult> {
  switch (name) {
    case "navigate": {
      return navigateTo(String(params.page ?? ""));
    }

    case "open_dialog": {
      const dialog = String(params.dialog ?? "");
      const target = DIALOG_ACTIONS[dialog];
      if (!target) {
        return {
          success: false,
          message: `未知弹窗：${dialog}`,
          errorCode: "UNKNOWN_DIALOG",
          errorMessage: `弹窗 ${dialog} 不在 DIALOG_ACTIONS 中`,
        };
      }

      // 不在目标页面 / 该页还没注册 handler → 先跳转并等待挂载
      const activeId = uiActionRegistry.getActivePageId();
      if (
        activeId !== target.pageId ||
        !uiActionRegistry.resolveHandler(target.action)
      ) {
        const nav = await navigateTo(target.pageId);
        if (!nav.success) return nav;
        await waitForHandler(target.action);
      }

      const resolved = uiActionRegistry.resolveHandler(target.action);
      if (!resolved) {
        return {
          success: false,
          message: `「${target.label}」弹窗还没准备好（页面可能仍在加载）`,
          currentPage: activePage(),
          errorCode: "PAGE_NOT_READY",
          errorMessage: `handler ${target.action} 未注册`,
        };
      }

      const result = await runHandler(resolved.handler, params, target.label);

      // 打开后校验仍在目标页面：守卫重定向 / 页面被切走都算失败
      if (result.success) {
        const actualPage = uiActionRegistry.getActivePageId();
        if (actualPage && actualPage !== target.pageId) {
          return {
            ...result,
            success: false,
            message: `「${target.label}」打开后页面被切走`,
            actualState: {
              ...(result.actualState ?? {}),
              expectedPage: target.pageId,
              actualPage,
            },
            errorCode: "ROUTE_MISMATCH",
            errorMessage: `期望停留在 ${target.pageId}，实际 ${actualPage}`,
          };
        }
      }
      return result;
    }

    case "click_action": {
      const action = String(params.action ?? "");
      if (!action) {
        return {
          success: false,
          message: "缺少 action 参数",
          errorCode: "MISSING_PARAM",
          errorMessage: "click_action 需要 action",
        };
      }

      let resolved = uiActionRegistry.resolveHandler(action);
      if (!resolved) {
        // 可能属于另一个页面：找到归属页并跳转
        const owner = findOwnerPage(action);
        if (owner) {
          const nav = await navigateTo(owner);
          if (!nav.success) return nav;
          await waitForHandler(action);
          resolved = uiActionRegistry.resolveHandler(action);
        }
      }

      if (!resolved) {
        return {
          success: false,
          message: `当前页面不支持操作「${action}」`,
          currentPage: activePage(),
          errorCode: "ACTION_NOT_REGISTERED",
          errorMessage: `action ${action} 未注册`,
        };
      }

      // 去掉 action 字段本身，其余作为参数传给 handler
      const rest: Record<string, unknown> = { ...params };
      delete rest.action;
      return runHandler(resolved.handler, rest, action);
    }

    case "fill_form": {
      const fields =
        params.fields && typeof params.fields === "object"
          ? (params.fields as Record<string, unknown>)
          : {};
      const resolved = uiActionRegistry.resolveHandler("fill_form");
      if (!resolved) {
        return {
          success: false,
          message: "当前页面不支持自动填表（可以先把内容告诉用户，让他自己填）",
          currentPage: activePage(),
          errorCode: "ACTION_NOT_REGISTERED",
          errorMessage: "fill_form 未注册",
        };
      }
      return runHandler(resolved.handler, { fields }, "填写表单");
    }

    default:
      return {
        success: false,
        message: `未注册的界面操作：${name}`,
        currentPage: activePage(),
        errorCode: "ACTION_NOT_REGISTERED",
        errorMessage: `操作 ${name} 未注册`,
      };
  }
}
