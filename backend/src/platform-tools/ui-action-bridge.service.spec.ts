import { UIActionBridgeService } from './ui-action-bridge.service';

/**
 * UIActionBridgeService 单测。
 *
 * 只测内存通道本身（不碰 DB / 不启 Nest），覆盖需求里点名的几类场景：
 *   并发投递、超时、断线（无在线会话）、多标签页、重复指令、取消任务。
 */
describe('UIActionBridgeService', () => {
  let bridge: UIActionBridgeService;
  const user = 'user-1';

  beforeEach(() => {
    bridge = new UIActionBridgeService();
  });

  afterEach(() => {
    bridge.onModuleDestroy();
  });

  it('未注册会话时不在线；注册后在线', () => {
    expect(bridge.isBrowserOnline(user)).toBe(false);
    bridge.register(user, 's1');
    expect(bridge.isBrowserOnline(user)).toBe(true);
  });

  it('没有在线会话时投递失败（断线场景）', () => {
    const cmd = bridge.createCommand(
      { name: 'navigate', params: { page: 'skills' } },
      user,
    );
    expect(bridge.dispatch(cmd.commandId, user)).toBe(false);
  });

  it('生命周期：pending → delivered → success', async () => {
    bridge.register(user, 's1');
    const cmd = bridge.createCommand(
      { name: 'navigate', params: { page: 'skills' } },
      user,
    );
    expect(cmd.status).toBe('pending');

    // 先挂起长轮询，再投递 → 立刻送达（并发竞态：指令不会既入队又让人干等）
    const pollPromise = bridge.poll(user, 's1', 5_000);
    expect(bridge.dispatch(cmd.commandId, user)).toBe(true);

    const delivered = await pollPromise;
    expect(delivered).toHaveLength(1);
    expect(delivered[0].commandId).toBe(cmd.commandId);
    expect(delivered[0].status).toBe('delivered');

    const waitPromise = bridge.wait(cmd.commandId, user, 1_000);
    expect(
      bridge.resolve(cmd.commandId, user, {
        success: true,
        message: '已打开',
        currentPage: 'skills',
      }),
    ).toBe(true);
    await expect(waitPromise).resolves.toMatchObject({ success: true });
  });

  it('结果早于 wait 到达时也能拿到（避免 SSE/HTTP 时序竞争误判超时）', async () => {
    bridge.register(user, 's1');
    const cmd = bridge.createCommand({ name: 'navigate' }, user);

    // 前端先回传了结果（wait 还没注册）
    bridge.resolve(cmd.commandId, user, { success: true, message: '早到' });

    // 若没有早到缓存，这里会等满 200ms 后返回失败
    const outcome = await bridge.wait(cmd.commandId, user, 200);
    expect(outcome.success).toBe(true);
    expect(outcome.message).toBe('早到');
  });

  it('wait 超时返回失败（不会假装成功）', async () => {
    const cmd = bridge.createCommand({ name: 'navigate' }, user);
    const outcome = await bridge.wait(cmd.commandId, user, 50);
    expect(outcome.success).toBe(false);
    expect(outcome.errorCode).toBe('TIMEOUT');
  });

  it('同一指令不会被投递两次（幂等）', async () => {
    bridge.register(user, 's1');
    const cmd = bridge.createCommand({ name: 'navigate' }, user);

    expect(bridge.dispatch(cmd.commandId, user)).toBe(true);
    // 已 delivered，再投递应失败
    expect(bridge.dispatch(cmd.commandId, user)).toBe(false);

    const first = await bridge.poll(user, 's1', 50);
    expect(first).toHaveLength(1);
    // 取走后再轮询不会重复拿到
    const second = await bridge.poll(user, 's1', 50);
    expect(second).toHaveLength(0);
  });

  it('多标签页：投递给「用户最近活动」的会话', async () => {
    bridge.register(user, 'sA');
    bridge.register(user, 'sB');
    // 让 sA 成为用户最近活动的标签页
    await new Promise((resolve) => setTimeout(resolve, 5));
    bridge.heartbeat(user, 'sA');

    const cmd = bridge.createCommand({ name: 'navigate' }, user);
    const pollA = bridge.poll(user, 'sA', 500);
    const pollB = bridge.poll(user, 'sB', 200);

    expect(bridge.dispatch(cmd.commandId, user)).toBe(true);

    const [a, b] = await Promise.all([pollA, pollB]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });

  it('取消任务：清空后续指令、唤醒等待、Agent 可感知', async () => {
    bridge.register(user, 's1');
    const cmd1 = bridge.createCommand(
      { name: 'navigate', taskId: 't1' },
      user,
    );
    const cmd2 = bridge.createCommand(
      { name: 'fill_form', taskId: 't1' },
      user,
    );
    bridge.dispatch(cmd1.commandId, user);
    bridge.dispatch(cmd2.commandId, user);

    const waitPromise = bridge.wait(cmd1.commandId, user, 1_000);
    const cancelled = bridge.cancelTask('t1', user);

    expect(cancelled).toBeGreaterThan(0);
    expect(bridge.isTaskCancelled('t1')).toBe(true);
    await expect(waitPromise).resolves.toMatchObject({ cancelled: true });

    // 队列里剩余的 cmd2 不会再被取走
    const rest = await bridge.poll(user, 's1', 50);
    expect(rest).toHaveLength(0);
  });

  it('越权回传被拒绝', () => {
    const cmd = bridge.createCommand({ name: 'navigate' }, user);
    expect(
      bridge.resolve(cmd.commandId, 'someone-else', {
        success: true,
        message: '伪造',
      }),
    ).toBe(false);
  });

  it('过期指令不再投递', () => {
    bridge.register(user, 's1');
    const cmd = bridge.createCommand({ name: 'navigate' }, user);
    // 手动让它过期
    (cmd as { expiresAt: number }).expiresAt = Date.now() - 1;
    expect(bridge.dispatch(cmd.commandId, user)).toBe(false);
  });

  it('会话列表按最近活动排序', () => {
    bridge.register(user, 'sA');
    bridge.register(user, 'sB');
    bridge.heartbeat(user, 'sA');
    const sessions = bridge.listSessions(user);
    expect(sessions.map((s) => s.sessionId)).toEqual(['sA', 'sB']);
  });
});
