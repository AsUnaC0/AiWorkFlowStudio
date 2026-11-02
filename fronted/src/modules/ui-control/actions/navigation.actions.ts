import type { UIActionDescriptor } from "../types";

/**
 * 导航类操作。
 *
 * 页面跳转走 Vue Router，不依赖任何 DOM 选择器 ——
 * 这是所有界面操作里最稳定的一种，因此也承担「先跳转再执行」的职责。
 */
export const navigationActions: UIActionDescriptor[] = [
  {
    name: "navigate",
    label: "页面跳转",
    description: "跳转到平台内的指定页面（只切换页面，不修改数据）",
    category: "navigation",
    risk: "LOW",
  },
];
