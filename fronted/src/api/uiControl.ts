import axios from "axios";
import { request } from "@/utils/request";
import { useUserStore } from "@/stores/user";
import type { UIContextPayload } from "@/modules/ui-control/types";

export interface UIActionReport {
  /** 后端在 ui_action 事件里下发的操作 ID */
  actionId: string;
  success: boolean;
  message: string;
  currentRoute?: string;
  /** 执行后的页面 id（skills / mcp / …） */
  currentPage?: string;
  /** 真实页面状态快照（dialogVisible / selectedTab …） */
  actualState?: Record<string, unknown>;
  /** 结构化错误码 / 错误信息 */
  errorCode?: string;
  errorMessage?: string;
  /** 是否因用户取消而终止 */
  cancelled?: boolean;
  data?: Record<string, unknown>;
}

/**
 * 回传界面操作的执行结果。
 *
 * 后端在发出 `ui_action` 后会挂起等待这个回传（超时按失败处理），
 * 因此前端无论成功失败都必须调用一次，否则模型要等满超时。
 */
export const reportUIActionResult = (
  payload: UIActionReport,
): Promise<{ resolved: boolean }> => {
  return request.post("/platform/ui-result", payload);
};

// ===========================================================================
// 指令通道（桌宠 → 网页版）
// ===========================================================================

/** 指令生命周期状态（与后端一致） */
export type UICommandStatus =
  | "pending"
  | "delivered"
  | "executing"
  | "success"
  | "failed"
  | "expired"
  | "cancelled";

/** 一条待执行的界面指令（后端下发的线上格式） */
export interface UICommandPayload {
  commandId: string;
  /** 所属任务（用户喊停时按它取消） */
  taskId?: string;
  /** navigate / open_dialog / click_action / fill_form */
  name: string;
  params?: Record<string, unknown>;
  tool?: string;
  label?: string;
  status?: UICommandStatus;
  createdAt?: number;
  expiresAt?: number;
  retryCount?: number;
}

/**
 * 静默请求实例。
 *
 * 指令轮询是后台常驻请求，不能走全局拦截器：
 * 一旦 token 过期，全局拦截器会弹「登录已过期」并跳登录页 ——
 * 用户正在别的页面干活时被一个后台轮询踢出去，体验很差。
 * 这里失败就静默重试，真正的 401 由用户自己的操作暴露。
 */
const silentRequest = axios.create({ baseURL: "/api", timeout: 40_000 });

silentRequest.interceptors.request.use((config) => {
  const token = useUserStore().token;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

/** 注册浏览器会话（一个标签页一个 sessionId） */
export const registerUISession = (
  sessionId: string,
): Promise<{ registered: boolean }> => {
  return silentRequest
    .post<{ registered: boolean }>("/platform/ui-command/register", {
      sessionId,
    })
    .then((res) => res.data);
};

/** 浏览器心跳（可选；poll 本身也会刷新在线状态） */
export const heartbeatUISession = (
  sessionId: string,
): Promise<{ ok: boolean }> => {
  return silentRequest
    .post<{ ok: boolean }>("/platform/ui-command/heartbeat", { sessionId })
    .then((res) => res.data);
};

/**
 * 长轮询取下一条界面指令。
 *
 * 没有指令时后端会挂起 timeoutMs（默认 20 秒）后返回空数组，
 * 前端拿到空数组立刻再发一次，形成「准实时」通道。
 *
 * 顺便把当前页面上下文带上去：桌宠看不见浏览器，
 * 只有这里上报了，模型才知道用户现在停在哪一页。
 */
export const pollUICommands = (
  timeoutMs = 20_000,
  sessionId?: string,
  uiContext?: UIContextPayload,
): Promise<{ commands: UICommandPayload[] }> => {
  return silentRequest
    .post<{ commands: UICommandPayload[] }>(
      "/platform/ui-command/poll",
      { timeout: timeoutMs, sessionId, uiContext },
      // 比后端挂起时间多留 15 秒，避免网络抖动被误判成超时
      { timeout: timeoutMs + 15_000 },
    )
    .then((res) => res.data);
};

/**
 * 取消一个进行中的界面任务。
 *
 * 用户主动喊停时调用：后端会清掉尚未执行的后续指令、
 * 立刻唤醒正在等待的 Agent，并让它停止后续步骤。
 */
export const cancelUITask = (taskId: string): Promise<{ cancelled: number }> => {
  return request.post("/platform/ui-command/cancel", { taskId });
};
