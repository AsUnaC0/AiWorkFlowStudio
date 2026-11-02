import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type {
  UIActionResultPayload,
  UIBrowserSessionSummary,
  UICommandWire,
  UIContextPayload,
} from './ui-action.types';

/**
 * 内部指令：线上格式 + 归属用户。
 *
 * `userId` 只留在服务端用于鉴权，**绝不**通过 poll 下发给前端。
 */
interface StoredCommand extends UICommandWire {
  userId: string;
  /**
   * 是否已经投递过（入队或直接交给 waiter）。
   *
   * 为什么需要它：指令入队后状态仍是 `pending`（要等浏览器领取才算 delivered），
   * 只靠 status 判断会导致「重复 dispatch → 同一指令在队列里出现两次 → 执行两次」。
   */
  dispatched: boolean;
}

/** 浏览器会话（一个标签页一个 sessionId） */
interface BrowserSession {
  sessionId: string;
  userId: string;
  /** 尚未被领取的指令（按创建顺序） */
  queue: StoredCommand[];
  /** 正在长轮询等待的请求（有新指令时立刻唤醒） */
  waiters: Array<(commands: UICommandWire[]) => void>;
  /** 最近一次轮询时间 */
  lastPollAt: number;
  /** 最近一次有效活动时间（轮询 / 心跳 / 结果回传），用于判断在线 */
  lastActivityAt: number;
  /**
   * 最近一次「用户真的在看这个标签页」的时间（可见性 / 聚焦心跳）。
   *
   * 与 `lastActivityAt` 的区别：后台标签页也在持续轮询，`lastActivityAt` 会被
   * 刷新得很新，无法反映用户实际在看哪个 tab。多标签页选目标时必须用这个字段，
   * 否则指令会随机落到某个后台标签页上。
   */
  lastUserActivityAt: number;
  /** 网页版最近一次上报的页面上下文 */
  lastContext?: UIContextPayload;
  contextAt: number;
}

/** 正在等待前端回传结果的界面操作 */
interface PendingUIAction {
  userId: string;
  resolve: (result: UIActionResultPayload) => void;
  timer: ReturnType<typeof setTimeout>;
  createdAt: number;
}

/** 早到的执行结果（结果先于 wait 注册就到达时的暂存） */
interface EarlyResult {
  userId: string;
  result: UIActionResultPayload;
}

/** 超过这个时间没有任何活动，就认为该会话离线 */
const BROWSER_ONLINE_WINDOW_MS = 45_000;

/** 会话彻底空闲多久后回收（避免 Map 无限增长） */
const SESSION_IDLE_WINDOW_MS = 120_000;

/** 单个会话最多积压多少条指令（防止长期不在线时无限堆积） */
const MAX_QUEUED_COMMANDS = 10;

/** 指令从创建到被领取的最长存活时间（超时即过期，不再执行） */
const COMMAND_EXPIRY_MS = 30_000;

/** 终态指令在内存里保留多久（用于幂等判断与排查） */
const TERMINAL_RETENTION_MS = 300_000;

/** 任务取消标记保留多久 */
const CANCELLED_TASK_TTL_MS = 300_000;

/** 后台清理间隔 */
const SWEEP_INTERVAL_MS = 15_000;

/**
 * UIActionBridgeService —— 后端与前端之间的「界面操作」桥。
 *
 * 三条链路都在这里：
 *
 * 【下行】后端 → 浏览器（`dispatch` / `poll`）
 *   桌宠那一轮对话没有能力执行界面操作，需要网页版代为执行。
 *   后端把指令投递到**该用户某个浏览器会话**的队列，网页版长轮询取走。
 *   多标签页时按「最近活动」选目标会话，避免 Tab B 抢走本该给 Tab A 的指令。
 *
 * 【上行】前端 → 后端（`wait` / `resolve`）
 *   SSE 是单向流。模型调用 `ui_navigate` 时，真正的执行发生在前端。
 *   如果后端发完指令就当成功，模型就会「假设」页面已经打开 ——
 *   这正是需求文档里明确禁止的。
 *   做法：AgentService 先 `createCommand()` 建指令，前端执行完
 *   POST `/platform/ui-result` → Controller 调 `resolve()` →
 *   `wait()` 返回真实结果，再作为工具结果喂回模型。
 *
 * 【控制】取消（`cancelTask` / `isTaskCancelled`）
 *   用户在任务执行中喊停：清掉未领取的指令、立刻唤醒挂起的等待，
 *   并打上任务级取消标记，Agent 下一轮检测到就停止后续步骤。
 *
 * 超时兜底：前端不在线时等待超时返回失败，绝不假装成功。
 */
@Injectable()
export class UIActionBridgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UIActionBridgeService.name);

  /** 正在等待前端回传结果的界面操作（按 commandId） */
  private readonly pending = new Map<string, PendingUIAction>();

  /** 结果先于 wait 到达时的暂存（按 commandId），避免 SSE 与 HTTP 时序竞争丢结果 */
  private readonly earlyResults = new Map<string, EarlyResult>();

  /** 所有指令（含终态），用于状态查询、幂等与取消 */
  private readonly commands = new Map<string, StoredCommand>();

  /** 按用户 → 会话 划分的浏览器通道 */
  private readonly sessions = new Map<string, Map<string, BrowserSession>>();

  /** 已取消的任务（taskId → 过期时间戳） */
  private readonly cancelledTasks = new Map<string, number>();

  private sweepTimer?: ReturnType<typeof setInterval>;

  onModuleInit(): void {
    // unref：不让定时器拖住进程退出（测试 / 优雅停机）
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  // =========================================================================
  // 会话管理
  // =========================================================================

  private ensureSession(userId: string, sessionId: string): BrowserSession {
    let map = this.sessions.get(userId);
    if (!map) {
      map = new Map();
      this.sessions.set(userId, map);
    }
    let session = map.get(sessionId);
    if (!session) {
      const now = Date.now();
      session = {
        sessionId,
        userId,
        queue: [],
        waiters: [],
        lastPollAt: now,
        lastActivityAt: now,
        // 打开标签页 = 用户此刻在看它
        lastUserActivityAt: now,
        contextAt: 0,
      };
      map.set(sessionId, session);
    }
    return session;
  }

  /** 浏览器启动时注册会话（幂等） */
  register(userId: string, sessionId: string): void {
    const session = this.ensureSession(userId, sessionId);
    const now = Date.now();
    session.lastActivityAt = now;
    session.lastUserActivityAt = now;
  }

  /**
   * 心跳：刷新「用户活动」时间。
   *
   * 前端在标签页重新可见 / 窗口聚焦时调用 —— 这是「用户现在在看哪个 tab」
   * 最可靠的信号，多标签页选目标就靠它。
   */
  heartbeat(userId: string, sessionId: string): void {
    const session = this.ensureSession(userId, sessionId);
    const now = Date.now();
    session.lastActivityAt = now;
    session.lastUserActivityAt = now;
  }

  /** 会话是否在线（有挂起的长轮询，或最近有活动） */
  private sessionOnline(session: BrowserSession, now: number): boolean {
    if (session.waiters.length > 0) return true;
    return now - session.lastActivityAt < BROWSER_ONLINE_WINDOW_MS;
  }

  /**
   * 选择投递目标会话。
   *
   * 多标签页时优先「最近活动」的那个 —— 用户正在看的页面最可能是想操作的对象。
   * 没有任何在线会话则返回 null（调用方据此如实告诉模型「网页版没打开」）。
   */
  private pickTargetSession(userId: string): BrowserSession | null {
    const map = this.sessions.get(userId);
    if (!map) return null;
    const now = Date.now();

    const online: BrowserSession[] = [];
    for (const session of map.values()) {
      if (this.sessionOnline(session, now)) online.push(session);
    }
    if (online.length === 0) return null;
    if (online.length === 1) return online[0];

    // 多个标签页：优先「用户最近真的看过」的那个。
    // 只比 lastActivityAt 会被后台标签页的轮询时间污染 —— 后台 tab 每 20 秒
    // 也在轮询，时间戳一样新，指令就会随机落到看不见的标签页上。
    const userRecent = online.filter(
      (session) => now - session.lastUserActivityAt < BROWSER_ONLINE_WINDOW_MS,
    );

    let best: BrowserSession;
    if (userRecent.length > 0) {
      best = userRecent[0];
      for (const session of userRecent) {
        if (session.lastUserActivityAt > best.lastUserActivityAt) best = session;
      }
      return best;
    }

    // 都没有「用户活动」信号（例如刚启动）：退回最近轮询的那个
    best = online[0];
    for (const session of online) {
      if (session.lastActivityAt > best.lastActivityAt) best = session;
    }
    return best;
  }

  /** 网页版是否在线（任一标签页） */
  isBrowserOnline(userId: string): boolean {
    const map = this.sessions.get(userId);
    if (!map) return false;
    const now = Date.now();
    for (const session of map.values()) {
      if (this.sessionOnline(session, now)) return true;
    }
    return false;
  }

  /**
   * 网页版最近上报的页面上下文。
   *
   * 只采信「在线且上下文未过期」的会话 —— 用户关了网页半小时后再问桌宠，
   * 不该还被告知停在某个旧页面。
   */
  getBrowserContext(
    userId: string,
    sessionId?: string,
  ): UIContextPayload | undefined {
    const map = this.sessions.get(userId);
    if (!map) return undefined;
    const now = Date.now();

    if (sessionId) {
      const session = map.get(sessionId);
      if (!session) return undefined;
      if (!session.lastContext) return undefined;
      if (now - session.contextAt > BROWSER_ONLINE_WINDOW_MS) return undefined;
      return session.lastContext;
    }

    // 未指定会话：取最近活动且有新鲜上下文的那个
    let best: BrowserSession | null = null;
    for (const session of map.values()) {
      if (!this.sessionOnline(session, now)) continue;
      if (!session.lastContext) continue;
      if (now - session.contextAt > BROWSER_ONLINE_WINDOW_MS) continue;
      if (!best || session.lastActivityAt > best.lastActivityAt) best = session;
    }
    return best?.lastContext;
  }

  /** 列出某用户的所有浏览器会话（给「选择目标标签页」等界面用） */
  listSessions(userId: string): UIBrowserSessionSummary[] {
    const map = this.sessions.get(userId);
    if (!map) return [];
    const now = Date.now();
    return [...map.values()]
      .map((session) => ({
        sessionId: session.sessionId,
        status: this.sessionOnline(session, now)
          ? ('online' as const)
          : ('offline' as const),
        lastActivityAt: session.lastActivityAt,
        pageId: session.lastContext?.pageId,
        route: session.lastContext?.route,
        title: session.lastContext?.title,
        openDialog: session.lastContext?.openDialog,
        queued: session.queue.filter((c) => c.status === 'pending').length,
      }))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  // =========================================================================
  // 指令创建 / 投递
  // =========================================================================

  /**
   * 创建一条指令（不投递）。
   *
   * 网页版聊天自己执行（uiControl=true）时只创建不投递：
   * 它通过 SSE 拿到指令并回传结果，不经过队列，避免重复执行。
   */
  createCommand(
    input: {
      commandId?: string;
      taskId?: string;
      name: string;
      params?: Record<string, unknown>;
      tool?: string;
      label?: string;
    },
    userId: string,
  ): UICommandWire {
    const now = Date.now();
    const command: StoredCommand = {
      commandId: input.commandId ?? randomUUID(),
      taskId: input.taskId,
      name: input.name,
      params: input.params,
      tool: input.tool,
      label: input.label,
      status: 'pending',
      createdAt: now,
      expiresAt: now + COMMAND_EXPIRY_MS,
      retryCount: 0,
      userId,
      dispatched: false,
    };
    this.commands.set(command.commandId, command);
    return command;
  }

  /**
   * 把已创建的指令投递到某个浏览器会话。
   *
   * @returns 是否投递成功（false = 没有任何在线浏览器，指令没人执行）
   */
  dispatch(commandId: string, userId: string, targetSessionId?: string): boolean {
    const command = this.commands.get(commandId);
    if (!command || command.userId !== userId) return false;
    // 已投递过 / 已取消 / 已过期的指令不再投递（防止同一指令执行两次）
    if (
      command.dispatched ||
      command.status !== 'pending' ||
      command.expiresAt <= Date.now()
    ) {
      return false;
    }

    const session = targetSessionId
      ? this.ensureSession(userId, targetSessionId)
      : this.pickTargetSession(userId);
    if (!session) return false;

    // 标记已投递：入队后状态仍是 pending，必须靠这个标记挡住重复投递
    command.dispatched = true;

    // 原子领取：单线程内同步完成「取 waiter / 入队」，publish 与 poll 不会交错
    const waiter = session.waiters.shift();
    if (waiter) {
      command.status = 'delivered';
      waiter([this.toWire(command)]);
    } else {
      session.queue.push(command);
      if (session.queue.length > MAX_QUEUED_COMMANDS) {
        const overflow = session.queue.splice(
          0,
          session.queue.length - MAX_QUEUED_COMMANDS,
        );
        for (const dropped of overflow) {
          if (dropped.status === 'pending') dropped.status = 'expired';
        }
        this.logger.warn(
          `用户 ${userId} 的界面指令积压过多，丢弃 ${overflow.length} 条旧指令`,
        );
      }
    }
    session.lastActivityAt = Date.now();
    return true;
  }

  /**
   * 浏览器长轮询取指令。
   *
   * 原子化：先看队列（同步取走），没有才注册 waiter。因为整段是同步执行，
   * 不存在「指令已入队但浏览器还在等」的中间态。
   *
   * 顺带接收网页版上报的页面上下文：桌宠发起对话时没有页面信息，
   * 靠这里补上，模型才知道「用户现在停在哪一页」。
   */
  poll(
    userId: string,
    sessionId: string,
    timeoutMs = 20_000,
    context?: UIContextPayload,
  ): Promise<UICommandWire[]> {
    const session = this.ensureSession(userId, sessionId);
    const now = Date.now();
    session.lastPollAt = now;
    session.lastActivityAt = now;

    if (context) {
      session.lastContext = context;
      session.contextAt = now;
    }

    // 1) 队列里已有可执行指令：直接取走（顺带清掉已过期的）
    if (session.queue.length > 0) {
      const alive: StoredCommand[] = [];
      for (const command of session.queue) {
        if (command.status !== 'pending' || command.expiresAt <= now) {
          if (command.status === 'pending') command.status = 'expired';
          continue;
        }
        alive.push(command);
      }
      session.queue = alive;

      const next = alive.shift();
      if (next) {
        next.status = 'delivered';
        session.queue = alive;
        return Promise.resolve([this.toWire(next)]);
      }
    }

    // 2) 没有指令：注册 waiter，最长挂起 timeoutMs
    return new Promise<UICommandWire[]>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (commands: UICommandWire[]): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const index = session.waiters.indexOf(finish);
        if (index >= 0) session.waiters.splice(index, 1);
        resolve(commands);
      };

      timer = setTimeout(() => finish([]), timeoutMs);
      session.waiters.push(finish);
    });
  }

  /** 内部 → 线上格式（剥离 userId） */
  private toWire(command: StoredCommand): UICommandWire {
    return {
      commandId: command.commandId,
      taskId: command.taskId,
      name: command.name,
      params: command.params,
      tool: command.tool,
      label: command.label,
      status: command.status,
      createdAt: command.createdAt,
      expiresAt: command.expiresAt,
      retryCount: command.retryCount,
    };
  }

  // =========================================================================
  // 上行：等前端回传执行结果
  // =========================================================================

  /** 等待前端回传结果；超时返回失败（调用方据此如实告诉模型） */
  wait(
    commandId: string,
    userId: string,
    timeoutMs = 15_000,
  ): Promise<UIActionResultPayload> {
    // 结果可能比 wait 先到（SSE 发出后前端立刻执行并 POST）。
    // 不处理这个时序竞争就会「结果丢了 → 干等 15 秒 → 误判失败」。
    const early = this.earlyResults.get(commandId);
    if (early) {
      this.earlyResults.delete(commandId);
      if (early.userId === userId) return Promise.resolve(early.result);
    }

    return new Promise<UIActionResultPayload>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(commandId);
        const command = this.commands.get(commandId);
        if (
          command &&
          (command.status === 'pending' ||
            command.status === 'delivered' ||
            command.status === 'executing')
        ) {
          command.status = 'expired';
          this.removeFromQueues(commandId);
        }
        this.logger.warn(
          `界面操作 ${commandId} 等待前端回传超时（${timeoutMs}ms），按未执行处理`,
        );
        resolve({
          success: false,
          message: '页面未响应（可能已离开聊天页或客户端不支持界面操作）',
          errorCode: 'TIMEOUT',
          errorMessage: `等待前端回传超过 ${timeoutMs}ms`,
        });
      }, timeoutMs);

      this.pending.set(commandId, {
        userId,
        timer,
        createdAt: Date.now(),
        resolve: (result) => {
          clearTimeout(timer);
          this.pending.delete(commandId);
          resolve(result);
        },
      });
    });
  }

  /**
   * 前端回传执行结果。
   * @returns 是否命中（false 表示不存在 / 越权）
   */
  resolve(
    commandId: string,
    userId: string,
    result: UIActionResultPayload,
  ): boolean {
    const command = this.commands.get(commandId);

    // 只允许「发起这次操作的用户」回传结果，避免跨会话串改
    if (command && command.userId !== userId) {
      this.logger.warn(
        `用户 ${userId} 试图回传不属于自己的界面操作 ${commandId}，已忽略`,
      );
      return false;
    }

    // 更新指令生命周期（取消优先，避免取消后被迟到的成功结果覆盖）
    if (command && command.status !== 'cancelled') {
      command.status = result.cancelled
        ? 'cancelled'
        : result.success
          ? 'success'
          : 'failed';
    }

    const entry = this.pending.get(commandId);
    if (entry) {
      if (entry.userId !== userId) {
        this.logger.warn(
          `用户 ${userId} 试图回传不属于自己的界面操作 ${commandId}，已忽略`,
        );
        return false;
      }
      entry.resolve(result);
      return true;
    }

    // 没有等待者：说明结果先到（或早已超时）。
    // 暂存起来，等 wait() 来取；超出容量就丢最旧的，避免无界增长。
    if (!command) return false;
    this.earlyResults.set(commandId, { userId, result });
    if (this.earlyResults.size > 200) {
      const oldest = this.earlyResults.keys().next().value;
      if (oldest) this.earlyResults.delete(oldest);
    }
    return true;
  }

  /** 当前挂起中的操作数（健康检查 / 调试用） */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** 当前在线的浏览器会话数（健康检查 / 调试用） */
  get onlineBrowserCount(): number {
    const now = Date.now();
    let count = 0;
    for (const map of this.sessions.values()) {
      for (const session of map.values()) {
        if (this.sessionOnline(session, now)) count++;
      }
    }
    return count;
  }

  // =========================================================================
  // 任务取消
  // =========================================================================

  /**
   * 取消一个任务。
   *
   * 做三件事：
   *   1. 打任务级取消标记 —— Agent 下一轮检测到就不再继续后续步骤；
   *   2. 清掉队列里尚未领取的指令；
   *   3. 立刻唤醒正在等待结果的调用（否则要干等到超时）。
   *
   * 注意：已经**执行中**的操作无法回滚，这里只保证「不再继续」。
   *
   * @returns 受影响的指令数
   */
  cancelTask(taskId: string, userId: string): number {
    if (!taskId) return 0;
    this.cancelledTasks.set(taskId, Date.now() + CANCELLED_TASK_TTL_MS);

    let affected = 0;

    // 1) 清队列（只清自己的会话）
    const map = this.sessions.get(userId);
    if (map) {
      for (const session of map.values()) {
        const keep: StoredCommand[] = [];
        for (const command of session.queue) {
          if (command.taskId === taskId && command.status === 'pending') {
            command.status = 'cancelled';
            affected++;
          } else {
            keep.push(command);
          }
        }
        session.queue = keep;
      }
    }

    // 2) 唤醒正在等待的调用（先收集再 resolve，避免遍历中删除）
    const waiting: string[] = [];
    for (const [commandId, entry] of this.pending) {
      const command = this.commands.get(commandId);
      if (command?.taskId === taskId && entry.userId === userId) {
        waiting.push(commandId);
      }
    }
    for (const commandId of waiting) {
      const command = this.commands.get(commandId);
      if (command) command.status = 'cancelled';
      this.pending.get(commandId)?.resolve({
        success: false,
        cancelled: true,
        message: '用户已取消该任务',
        errorCode: 'CANCELLED',
        errorMessage: '任务被用户取消',
      });
      affected++;
    }

    if (affected > 0) {
      this.logger.log(
        `用户 ${userId} 取消了任务 ${taskId}，影响 ${affected} 条界面指令`,
      );
    }
    return affected;
  }

  /** 任务是否已被取消（Agent 在步骤之间检查） */
  isTaskCancelled(taskId?: string): boolean {
    if (!taskId) return false;
    const expiresAt = this.cancelledTasks.get(taskId);
    if (!expiresAt) return false;
    if (Date.now() > expiresAt) {
      this.cancelledTasks.delete(taskId);
      return false;
    }
    return true;
  }

  /** 把一条指令从所有会话队列里移除（超时兜底，避免浏览器执行过期任务） */
  private removeFromQueues(commandId: string): void {
    for (const map of this.sessions.values()) {
      for (const session of map.values()) {
        const index = session.queue.findIndex(
          (command) => command.commandId === commandId,
        );
        if (index >= 0) session.queue.splice(index, 1);
      }
    }
  }

  // =========================================================================
  // 后台清理
  // =========================================================================

  /**
   * 定期清理：
   *   - 队列里过期的指令 → expired
   *   - 长时间空闲的会话 → 回收
   *   - 终态指令 / 取消标记 → 过期删除
   */
  private sweep(): void {
    const now = Date.now();

    for (const [userId, map] of this.sessions) {
      for (const [sessionId, session] of map) {
        if (session.queue.length > 0) {
          const keep: StoredCommand[] = [];
          for (const command of session.queue) {
            if (command.expiresAt <= now) {
              if (command.status === 'pending') command.status = 'expired';
              continue;
            }
            keep.push(command);
          }
          session.queue = keep;
        }

        // 没有挂起轮询、且长时间无活动 → 回收会话
        if (
          session.waiters.length === 0 &&
          now - session.lastActivityAt > SESSION_IDLE_WINDOW_MS
        ) {
          map.delete(sessionId);
        }
      }
      if (map.size === 0) this.sessions.delete(userId);
    }

    for (const [commandId, command] of this.commands) {
      // 未进入终态但已过期（例如投递失败、没人领取）→ 标为 expired，
      // 否则这些指令会永远停留在 pending，既不执行也不回收。
      const active =
        command.status === 'pending' ||
        command.status === 'delivered' ||
        command.status === 'executing';
      if (active && now > command.expiresAt) {
        command.status = 'expired';
      }

      const terminal =
        command.status === 'success' ||
        command.status === 'failed' ||
        command.status === 'expired' ||
        command.status === 'cancelled';
      const expiredTooLong = now > command.expiresAt + TERMINAL_RETENTION_MS;
      if (terminal && expiredTooLong) {
        this.commands.delete(commandId);
        this.earlyResults.delete(commandId);
      }
    }

    for (const [taskId, expiresAt] of this.cancelledTasks) {
      if (now > expiresAt) this.cancelledTasks.delete(taskId);
    }
  }
}
