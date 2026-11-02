import { uiActionRegistry } from "./registry";
import type { UIContextPayload } from "./types";

/**
 * 生成随聊天请求上报的「当前页面上下文」。
 *
 * 后端会把它注入 System Prompt 的「用户当前所在的页面」段落，
 * 让模型知道用户在哪、能执行哪些界面操作。
 *
 * 没有激活页面（如独立路由 / 登录页）时返回 undefined，
 * 后端就不会注入该段 —— 模型不会误以为用户停在某个页面。
 */
export function getCurrentUIContext(): UIContextPayload | undefined {
  const ctx = uiActionRegistry.getActivePageContext();
  if (!ctx) return undefined;

  return {
    pageId: ctx.pageId,
    title: ctx.title,
    route: ctx.route,
    description: ctx.description,
    availableActions: ctx.actions?.map((a) => ({
      name: a.name,
      label: a.label,
      description: a.description,
    })),
  };
}
