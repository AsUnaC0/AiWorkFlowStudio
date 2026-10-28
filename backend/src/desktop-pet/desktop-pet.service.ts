import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** 交接文件的有效期：够桌宠启动读走就行，越短越安全 */
const HANDOFF_TTL_MS = 60_000;

interface LaunchContext {
  /** 当前请求的 JWT —— 交给桌宠后台登录用 */
  token: string;
  /** 桌宠该连哪个后端（由请求的 Host 推断） */
  baseUrl: string;
  /** 当前用户 id —— 桌宠用它判断「是不是换了账号」，换了就丢掉旧会话 */
  userId: string;
  /** 用户邮箱 —— 桌宠面板里要显示，省一次 /auth/me */
  email: string;
}

/**
 * 桌宠客户端启动器。
 *
 * 为什么需要后端代劳：浏览器沙箱不允许网页直接拉起本地程序，
 * `<a href="xiaodie://...">` 这类自定义协议要先安装注册、开发期还常被浏览器拦。
 * 所以走一条确定能通的路：**网页 → 后端接口 → 后端在本机 spawn Electron**。
 *
 * 前提是后端和用户在同一台机器上（本项目就是本地部署）。
 * 如果后端跑在服务器上，这里会找不到 `desktop/` 目录并**明确报错**，
 * 而不是返回成功让人干等。
 *
 * 关于「重复点击」：桌宠主进程有 `requestSingleInstanceLock()`，
 * 第二次启动会立刻退出、并让第一个实例把窗口显示出来。
 * 所以这里可以放心 spawn，不需要自己维护「是否已在运行」的状态 ——
 * 语义天然就是「确保桌宠显示出来」。
 */
@Injectable()
export class DesktopPetService {
  private readonly logger = new Logger(DesktopPetService.name);

  /** 防连点：上一次 spawn 的时间戳 */
  private lastLaunchAt = 0;

  async launch(ctx: LaunchContext): Promise<{ ok: true; message: string }> {
    const now = Date.now();
    if (now - this.lastLaunchAt < 3000) {
      return { ok: true, message: '桌宠正在启动，稍等一下' };
    }

    const desktopDir = this.findDesktopDir();
    if (!desktopDir) {
      throw new ServiceUnavailableException(
        '没找到桌宠客户端目录（desktop/）。这个功能要求后端和桌宠在同一台机器上。',
      );
    }

    const binary = this.resolveElectronBinary(desktopDir);
    if (!binary) {
      throw new ServiceUnavailableException(
        '桌宠依赖还没装好（desktop/node_modules 里没有 Electron）。' +
          '先在 desktop 目录执行 npm install，再点一次。',
      );
    }

    this.lastLaunchAt = now;

    // ⚠️ 必须删掉 ELECTRON_RUN_AS_NODE：某些环境（含本项目开发机）预设了这个变量，
    // Electron 会以纯 Node 模式启动，直接报 `Cannot read properties of undefined` 然后退出。
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;

    // 把登录态交给桌宠，让它后台自动登录、不弹登录面板
    if (ctx.token) {
      const handoffPath = this.writeHandoff(ctx);
      if (handoffPath) env.XIAODIE_HANDOFF = handoffPath;
    }

    try {
      const child = spawn(binary, ['.'], {
        cwd: desktopDir,
        // detached + unref：桌宠要活过后端进程，不能挂成后端的子进程
        detached: true,
        stdio: 'ignore',
        env,
      });
      // spawn 的失败是异步事件，这里只需要防止未捕获异常；真正的「找不到文件」
      // 已经由上面的 existsSync 挡掉了
      child.on('error', (err) => {
        this.logger.error(`拉起桌宠失败：${err.message}`);
      });
      child.unref();
    } catch (e) {
      this.lastLaunchAt = 0;
      throw new ServiceUnavailableException(
        `拉起桌宠失败：${e instanceof Error ? e.message : String(e)}`,
      );
    }

    this.logger.log(`已拉起桌宠客户端（${binary}）`);
    return {
      ok: true,
      message: '已唤起桌宠；首次启动要等几秒，没看到的话看看是不是被别的窗口挡住了',
    };
  }

  /**
   * 写「一次性交接文件」，返回路径。
   *
   * 为什么不让 token 走命令行参数或环境变量本身：
   * **进程的命令行和部分环境信息对同机任何用户都可见**，
   * 那等于把 7 天有效的 JWT 写在公告板上。所以只传**文件路径**，
   * token 落在临时目录里，桌宠读走之后立刻删除。
   *
   * 文件用 0600 权限创建（仅当前用户可读），并在 60 秒后兜底清理 ——
   * 正常情况下桌宠启动时就已经读走并删掉了，这里的定时器只是防止
   * spawn 失败 / 桌宠没起来时留下垃圾。
   */
  private writeHandoff(ctx: LaunchContext): string | null {
    const file = join(tmpdir(), `xiaodie-handoff-${randomUUID()}.json`);
    try {
      writeFileSync(
        file,
        JSON.stringify({
          token: ctx.token,
          baseUrl: ctx.baseUrl,
          userId: ctx.userId,
          email: ctx.email,
          expiresAt: Date.now() + HANDOFF_TTL_MS,
        }),
        { encoding: 'utf8', mode: 0o600 },
      );
    } catch (e) {
      this.logger.warn(
        `写交接文件失败，桌宠将需要手动登录：${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }

    const timer = setTimeout(() => {
      try {
        unlinkSync(file);
      } catch {
        /* 已经被桌宠删掉了 */
      }
    }, HANDOFF_TTL_MS);
    // 别让这个定时器把后端进程钉住
    timer.unref();

    return file;
  }

  /**
   * 从 cwd 和 __dirname 分别往上找 `desktop/package.json`。
   *
   * 为什么要找而不是写死相对路径：后端可能以 `node dist/src/main.js` 启动（cwd=backend），
   * 也可能 `npm run start:dev`（cwd=backend），而 __dirname 在 dist 里层级又不同。
   * 逐级向上探测最稳，不用关心 tsconfig 的 rootDir 怎么配。
   */
  private findDesktopDir(): string | null {
    const starts = [process.cwd(), __dirname];

    for (const start of starts) {
      let dir = resolve(start);
      for (let depth = 0; depth < 6; depth++) {
        const candidate = join(dir, 'desktop');
        if (existsSync(join(candidate, 'package.json'))) {
          return candidate;
        }
        const parent = resolve(dir, '..');
        if (parent === dir) break; // 到盘符根了
        dir = parent;
      }
    }
    return null;
  }

  /** Electron 的二进制位置：各平台不一样，Windows 是 dist/electron.exe */
  private resolveElectronBinary(desktopDir: string): string | null {
    const dist = join(desktopDir, 'node_modules', 'electron', 'dist');
    const candidates =
      process.platform === 'win32'
        ? [join(dist, 'electron.exe')]
        : process.platform === 'darwin'
          ? [join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron')]
          : [join(dist, 'electron')];

    return candidates.find((p) => existsSync(p)) ?? null;
  }
}
