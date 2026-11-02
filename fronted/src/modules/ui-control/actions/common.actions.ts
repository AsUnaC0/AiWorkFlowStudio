import type { UIActionDescriptor } from "../types";

/**
 * 通用界面操作。
 *
 * 这些操作本身不含具体页面逻辑，实际执行函数由各页面在挂载时注册
 * （见 page-registration.ts）。这里只声明元信息，供模型与展示层使用。
 */
export const commonActions: UIActionDescriptor[] = [
  {
    name: "open_dialog",
    label: "打开弹窗",
    description: "打开页面上的「新建 / 创建」弹窗，让用户看到真实表单",
    category: "dialog",
    risk: "LOW",
  },
  {
    name: "click_action",
    label: "执行页面操作",
    description: "执行当前页面已注册的语义化操作（不修改业务数据）",
    category: "click",
    risk: "LOW",
  },
  {
    name: "fill_form",
    label: "填写表单",
    description: "把内容填入当前打开的创建表单（只填不提交）",
    category: "form",
    risk: "MEDIUM",
  },
];
