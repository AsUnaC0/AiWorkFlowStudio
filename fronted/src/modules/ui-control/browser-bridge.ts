import {
  heartbeatUISession,
  pollUICommands,
  registerUISession,
  reportUIActionResult,
  type UICommandPayload,
} from "@/api/uiControl";
import { useUserStore } from "@/stores/user";
import { getCurrentUIContext } from "./context";
import { executeUIAction, enqueueUIAction } from "./executor";
import { getBrowserSessionId } from "./session";
import type { UIActionResult } from "./types";

/**
 * 浏览器端「界面指令」接收器。
 *
 * 解决什么问题：
 *   用户在桌宠里说「帮我打开 Skill 页面，把名字填成 XXX」，
 *   桌宠是独立的 Electron 进程，动不了浏览器里的页面。
 *   后端于是把指令投递到该用户某个浏览器会话的队列，网页版在这里长轮询取走并执行。
 *
 * 为什么用长轮询而不是 WebSocket：
 *   后端没有开 CORS、也没引 socket.io；长轮询用现成的 HTTP 通道就能做到
 *   亚秒级响应（有指令时后端立刻返回，不用等满超时），零新依赖。
 *
 * 与聊天页内执行器的关系：
 *   网页版自己聊天时，后端**不会**投递到队列（避免同一指令执行两次），
 *   走的是 SSE 事件那条路。这里只处理「桌宠发起」的指令。
 */

/** 单次长轮询时长：后端会挂起这么久，有指令则立刻返回 */
const POLL_TIMEOUT_MS = 20_000;

/** 轮询失败（后端没起 / 断网）后的退避时间 */
const RETRY_DELAY_MS = 3_000;

/** token 失效后的退避时间：别每 3 秒撞一次 401 */
const AUTH_FAIL_DELAY_MS = 30_000;

/** 未登录时的空转间隔 */
const IDLE_DELAY_MS = 1_500;

/** 近期已处理指令（幂等：网络重试 / 重复投递不重复执行） */
const processedCommands = new Set<string>();
const PROCESSED_LIMIT = 500;

let running = false;
let stopped = false;
/** 已用哪个 token 注册过会话（token 变化时重新注册） */
let registeredToken: string | null = null;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 只有登录后才轮询；这里读 store 是安全的（调用发生在 app.use(pinia) 之后） */
function loggedIn(): boolean {
  try {
    return Boolean(useUserStore().token);
  } catch {
    return false;
  }
}

/** 记录已处理指令，超出上限丢最旧的，避免无界增长 */
function markProcessed(commandId: string): boolean {
  if (processedCommands.has(commandId)) return false;
  processedCommands.add(commandId);
  if (processedCommands.size > PROCESSED_LIMIT) {
    const oldest = processedCommands.values().next().value;
    if (oldest) processedCommands.delete(oldest);
  }
  return true;
}

/**
 * 执行一条指令并回传结果。
 *
 * 必须回传：后端在等这个结果，不回传模型要干等到超时。
 * 执行本身抛异常也要回传失败，不能悄悄吞掉。
 */
async function handleCommand(command: UICommandPayload): Promise<void> {
  // 幂等：同一条指令只执行一次
  if (!markProcessed(command.commandId)) return;

  await enqueueUIAction(async () => {
    let result: UIActionResult;
    try {
      result = await executeUIAction(command.name, command.params ?? {});
    } catch (error) {
      const message = error instanceof Error ? error.message : "界面操作失败";
      result = {
        success: false,
        message,
        errorCode: "EXECUTOR_ERROR",
        errorMessage: message,
      };
    }

    try {
      await reportUIActionResult({
        actionId: command.commandId,
        success: result.success,
        message: result.message,
        currentRoute: result.currentRoute,
        currentPage: result.currentPage,
        actualState: result.actualState,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        data: result.data,
      });
    } catch {
      // 回传失败只能让后端超时兜底；这里不重试，避免把过期结果补报到下一条指令
    }
  });
}

async function loop(): Promise<void> {
  while (!stopped) {
    if (!loggedIn()) {
      await sleep(IDLE_DELAY_MS);
      continue;
    }

    const token = useUserStore().token;

    // 登录态变化（首次登录 / 换账号）时注册会话，之后不再重复注册
    if (token !== registeredToken) {
      try {
        await registerUISession(getBrowserSessionId());
        registeredToken = token;
      } catch {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
    }

    try {
      // 每次轮询都带一次当前页面上下文：桌宠那边看不见浏览器，
      // 只有这里上报了，模型才知道用户停在哪一页、那页有哪些操作。
      const { commands } = await pollUICommands(
        POLL_TIMEOUT_MS,
        getBrowserSessionId(),
        getCurrentUIContext(),
      );
      if (stopped) break;

      for (const command of commands ?? []) {
        // 串行执行：界面操作会改路由 / 弹窗状态，不能并发
        await handleCommand(command);
      }
    } catch (error) {
      // 后端没起、断网、超时：退避后重来。
      // token 失效时拉长退避，避免每 3 秒撞一次 401（用户自己的操作会正常提示登录过期）。
      const status = (error as { response?: { status?: number } })?.response
        ?.status;
      if (status === 401) {
        // 重新登录后需要重新注册会话
        registeredToken = null;
        await sleep(AUTH_FAIL_DELAY_MS);
      } else {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  running = false;
}

/**
 * 绑定「用户正在看这个标签页」的心跳。
 *
 * 多标签页时后端要挑一个目标会话执行指令。只靠轮询时间无法区分
 * 「后台 tab 在轮询」和「用户真的在看」——后台 tab 的时间戳一样新。
 * 所以这里在标签页重新可见 / 窗口聚焦时上报一次心跳，
 * 后端据此优先把指令投给用户正在看的那个标签页。
 */
let activityBound = false;
function bindActivityHeartbeat(): void {
  if (activityBound) return;
  activityBound = true;

  const ping = () => {
    if (!loggedIn()) return;
    // 失败静默：心跳不是关键路径
    void heartbeatUISession(getBrowserSessionId()).catch(() => undefined);
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") ping();
  });
  window.addEventListener("focus", ping);
}

/** 启动指令接收器（应用启动时调用一次，重复调用无副作用） */
export function startUICommandBridge(): void {
  if (running) return;
  running = true;
  stopped = false;
  bindActivityHeartbeat();
  void loop();
}

/** 停止指令接收器（登出 / 应用卸载时调用） */
export function stopUICommandBridge(): void {
  stopped = true;
}
