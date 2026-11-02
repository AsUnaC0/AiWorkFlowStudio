/**
 * 浏览器会话 ID。
 *
 * 为什么需要它：
 *   同一个用户可能同时开着多个标签页（Skill 页、Workflow 页…）。
 *   如果后端只用 userId 做通道，两个 tab 会共享同一个队列和页面上下文，
 *   出现「Tab B 抢走了本该给 Tab A 的指令」「Tab B 的上下文覆盖 Tab A」。
 *
 * 为什么用 sessionStorage 而不是 localStorage：
 *   localStorage 同源共享 —— 两个 tab 会读到同一个 ID，等于没隔离。
 *   sessionStorage 是**每个标签页独立**的，且刷新后保留，
 *   正好满足「一个 tab 一个会话，刷新不换号」。
 *
 * 注意：复制标签页时部分浏览器会连同 sessionStorage 一起复制，
 * 这种情况下两个 tab 会共用会话 —— 属于可接受的边界。
 */

const STORAGE_KEY = "wb_ui_session_id";

function randomId(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID();
    }
  } catch {
    // 老浏览器 / 非安全上下文：退回时间戳 + 随机数
  }
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

let cached: string | null = null;

/** 取当前标签页的会话 ID（首次调用时生成并持久化到 sessionStorage） */
export function getBrowserSessionId(): string {
  if (cached) return cached;

  try {
    const existing = sessionStorage.getItem(STORAGE_KEY);
    if (existing) {
      cached = existing;
      return existing;
    }
  } catch {
    // 隐私模式可能禁用 storage：退化为内存内 ID
  }

  const id = randomId();
  try {
    sessionStorage.setItem(STORAGE_KEY, id);
  } catch {
    // ignore
  }
  cached = id;
  return id;
}
