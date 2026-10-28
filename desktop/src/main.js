'use strict';

/**
 * 小蝶桌宠 —— Electron 主进程
 *
 * 职责划分（重要）：
 *   主进程 = 窗口 / 托盘 / 配置 / **所有 HTTP 请求**（登录、拉平台助理、SSE 对话）
 *   渲染进程 = 只负责画面与交互，不碰网络、不碰 token
 *
 * 为什么网络必须放主进程：后端 main.ts 没有开 enableCors()，而渲染进程是 file:// 源
 * （Origin: null），直接 fetch 会被同源策略拦掉。主进程跑在 Node 里，不受 CORS 约束。
 * 附带好处：token 只存在于主进程，渲染进程拿不到，XSS 也偷不走。
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  screen,
  nativeImage,
  safeStorage,
  shell,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const tts = require('./tts');

/**
 * 关掉硬件加速 + 把 GPU 塞进主进程。
 *
 * 这台机器（以及不少虚拟机 / 远程桌面 / 显卡驱动异常的 Windows）上，
 * Electron 的 GPU **子进程**一启动就崩：`GPU process exited unexpectedly: exit_code=-1073741819`，
 * 连崩十几次后 `FATAL: GPU process isn't usable. Goodbye.` 直接退出 —— 表现是
 * `npm start` 一闪而过、什么都没有。
 *
 * 只调 disableHardwareAcceleration() 不够（实测仍然崩），必须三件一起：
 *   disable-gpu        不用 GPU 做合成
 *   in-process-gpu     别再单独 fork GPU 子进程（子进程才是崩的那个）
 *   no-sandbox         受限环境里沙箱起不来
 *
 * 桌宠只有透明窗口 + CSS 动画 + 内联 SVG，软件合成完全够用，关掉反而更稳。
 * 都必须在 app ready 之前调用。
 */
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('in-process-gpu');
app.disableHardwareAcceleration();

app.setName('XiaodiePet');

// 托盘图标（32x32 PNG，内联 base64，避免依赖外部素材文件）
const TRAY_ICON_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAB00lEQVR42mNgGAWjYBSQAGKsvP4Tgym26FJS8yUYJsViqjgE2XIQfpQ74T+5DiDZEdgsh2G6O4JalpPtiKf5ky+9LJr2vyUqm2Kc6xGxjyQHhFg4V62v6vtPTQwyk2gHTEgrXXRz1ob/1MQgM4myXFxAWOLh/K1Pf2869Z+aGGQmyGyCDnDWN3P9teHkf3RspWECx9jkiVEDMpugA+KdfBJ/rTvxHx2DDH388DHEcCzyxKgBmU3QAenuQVm/1h7/j45RfIdFnhg1ILMJOiDO0Svx5+qj/9ExsuHY5IlRAzKbcBrQNXX9ufLIf3SMYjgWeWLUgMwmnAv4hSTuTV3/9NfCXf/R8Y/lh4nC2PSCzASZTVRWnJtRvejX/J3/0fGPpYeIwtj0gswkuiDyNrTy+zlvx390/H3xAaIwNr0gM0kqjuekVS76vnD/f2pgkFkktws0pOS1TjfNufR9/r7/lGCQGSCzyGqcOGkZu15uW3T729y9/8nBIL0gMyhqnlmq6NhsL+7e92327v+kYJAekF6qNEb5OLn4y72iai41z7/9deau//gwSA1ILUgP1VvF4nyCErGWbomTovJmbCvo3HeyZsYlEAaxQWIgOZCa0f7DkAIA/ibtMiJe6LAAAAAASUVORK5CYII=';

/**
 * SSE 空闲兜底（详见 streamChat 里 armIdle 的注释）。
 *
 * 分两档，因为两种阶段的「正常静默」差别很大：
 *   - 思考/调工具阶段：模型可能几十秒不吐字，给足时间，别误判
 *   - 已经出字之后：token 间隔通常 50~200ms，几秒没动静就是真的结束了
 */
const SSE_IDLE_THINKING_MS = 90000;
const SSE_IDLE_STREAMING_MS = 5000;

const WIN_W = 340;
const WIN_H = 480;

/** @type {BrowserWindow | null} */
let win = null;
/** @type {Tray | null} */
let tray = null;
/** @type {any} */
let config = null;
/** 拖拽起点（窗口坐标），pointerdown 时记录 */
let dragOrigin = null;
/** 当前对话的 AbortController */
let chatAbort = null;
/** 渲染进程是否处于「可交互」状态（用于避免重复发 setIgnoreMouseEvents） */
let ignoringMouse = null;

// ===========================================================================
// 配置持久化
// ===========================================================================

function configFile() {
  return path.join(app.getPath('userData'), 'pet-config.json');
}

function defaults() {
  return {
    baseUrl: 'http://localhost:3000',
    /** 加密后的 token（base64），优先使用 */
    tokenEnc: null,
    /** 明文 token —— 仅当系统不支持 safeStorage 时才落到这里 */
    tokenPlain: null,
    email: '',
    userId: null,
    agentId: null,
    displayName: '',
    workspaceId: null,
    sessionId: null,
    position: null,
    clickThrough: true,
    petEnabled: true,
    /** 语音播报开关（本地偏好，默认开；关掉即「静音模式」，只出气泡不出声） */
    voiceEnabled: true,
    /** Edge TTS 音色 id（默认与后端人格一致） */
    voiceId: 'zh-CN-XiaoyiNeural',
  };
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(configFile(), 'utf8');
    return { ...defaults(), ...JSON.parse(raw) };
  } catch {
    return defaults();
  }
}

function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify(config, null, 2), 'utf8');
  } catch (error) {
    console.error('[config] 保存失败', error);
  }
}

// token 用系统钥匙串（Windows DPAPI）加密后再落盘，避免明文躺在磁盘上
function setToken(token) {
  config.tokenPlain = null;
  config.tokenEnc = null;
  if (!token) return;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      config.tokenEnc = safeStorage.encryptString(token).toString('base64');
      return;
    }
  } catch {
    /* 落到明文分支 */
  }
  config.tokenPlain = token;
}

function getToken() {
  if (config.tokenEnc) {
    try {
      return safeStorage.decryptString(Buffer.from(config.tokenEnc, 'base64'));
    } catch {
      return null;
    }
  }
  return config.tokenPlain || null;
}

// ===========================================================================
// 一次性交接：网页点「打开桌宠」时把登录态送过来
// ===========================================================================

/**
 * 读取并消费交接文件。
 *
 * 为什么用文件而不是命令行参数：**进程的命令行对同机任何用户都可见**，
 * 把 7 天有效的 JWT 写进 `--token=...` 等于写在公告板上。
 * 所以后端只通过环境变量传**文件路径**，token 落在临时文件里，
 * 这里读完立刻删除。
 *
 * 返回 `{ token, baseUrl, userId }`，或 null（没交接 / 过期 / 读不出来）。
 */
function consumeHandoff() {
  const file = process.env.XIAODIE_HANDOFF;
  if (!file) return null;

  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  } finally {
    // 读没读成功都删掉，别在磁盘上留副本
    try {
      fs.unlinkSync(file);
    } catch {
      /* 已经不在了 */
    }
  }

  try {
    const data = JSON.parse(raw);
    if (!data || typeof data.token !== 'string' || !data.token) return null;
    if (typeof data.expiresAt === 'number' && Date.now() > data.expiresAt) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * 把交接来的登录态并进 config，返回是否真的应用了。
 *
 * 用户是「先在网页登录，再点桌宠」，所以这里无条件采用交接的 token ——
 * 它一定比本地缓存的新（可能刚换过账号）。
 *
 * 只有确认换了账号时，才清掉旧的助理信息与会话：那些属于上一个用户，
 * 继续用会串数据。单机单人日常使用不会走到这个分支。
 */
function applyHandoffData(handoff) {
  if (!handoff || typeof handoff.token !== 'string' || !handoff.token) {
    return false;
  }

  // 先记下旧 token：判断「身份有没有真的变」要给 second-instance 决定是否 reload
  const previousToken = getToken();

  const switchedUser =
    Boolean(config.userId) &&
    Boolean(handoff.userId) &&
    config.userId !== handoff.userId;

  if (handoff.baseUrl) {
    config.baseUrl = String(handoff.baseUrl).replace(/\/+$/, '');
  }
  setToken(handoff.token);
  if (handoff.userId) config.userId = handoff.userId;

  if (switchedUser) {
    config.agentId = null;
    config.displayName = '';
    config.workspaceId = null;
    config.sessionId = null;
    config.email = '';
  }

  // 放在清空之后：换账号时上面刚把 email 抹掉，这里再填上新的
  if (handoff.email) config.email = handoff.email;

  saveConfig();
  // 返回「登录身份是否真的变了」——
  // 同一个账号重复点按钮不该把页面刷掉（气泡会闪一下），换了才需要 reload
  return switchedUser || previousToken !== handoff.token;
}

// ===========================================================================
// HTTP
// ===========================================================================

function baseUrl() {
  return String(config.baseUrl || 'http://localhost:3000').replace(/\/+$/, '');
}

/**
 * 从各种可能的错误响应里挖出可读文案。
 *
 * 本项目的 AllExceptionsFilter 返回 { statusCode, error, message }，
 * 但撞上别的服务（比如端口被占）时可能是 { status, retcode, data, wording } 之类，
 * 所以这里按优先级挨个试，都不行才回退到 HTTP 状态码。
 */
function extractErrorMessage(data, status) {
  if (!data || typeof data !== 'object') return `HTTP ${status}`;
  const candidates = [
    data.message,
    data.error,
    data.wording,
    data.msg,
    data.data && data.data.message,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (Array.isArray(candidate) && candidate.length) {
      return candidate.map(String).join('；');
    }
  }
  return `HTTP ${status}`;
}

/** 401 时给一句人话：优先用后端文案，但英文/空文案统一换成中文 */
function unauthorizedMessage(message) {
  if (!message || /^unauthorized$/i.test(message) || /^HTTP 401$/.test(message)) {
    return '邮箱或密码不正确（也可能是服务地址指向了别的后端）';
  }
  return message;
}

async function api(pathname, { method = 'GET', body, timeout = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const token = getToken();
  try {
    const res = await fetch(`${baseUrl()}/api${pathname}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!res.ok) {
      const raw = extractErrorMessage(data, res.status);
      const error = new Error(
        res.status === 401 ? unauthorizedMessage(raw) : raw,
      );
      error.status = res.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('请求超时：后端没响应，检查服务是否已启动');
    }
    if (error instanceof TypeError && /fetch failed/i.test(error.message)) {
      throw new Error(
        `连不上后端（${baseUrl()}），请先启动 backend 服务，或在设置里改服务地址`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 拉平台助理信息：agentId 就是它的 id，displayName 是人格名 */
async function fetchAssistantInfo() {
  const info = await api('/platform/assistant');
  config.agentId = info.id;
  config.displayName = info.displayName || info.name || '小蝶';
  config.workspaceId = info.currentWorkspaceId ?? null;
  config.petEnabled = info.persona?.desktopPetEnabled !== false;
  // 音色跟随人格配置（用户仍可在桌宠设置里改本地音色）
  if (info.persona?.voiceId) config.voiceId = info.persona.voiceId;
  saveConfig();
  return info;
}

/** 桌宠第一次说话时建一个专属会话，之后对话就有上下文了 */
async function ensureSession() {
  if (config.sessionId) return config.sessionId;
  if (!config.agentId) return null;
  try {
    const session = await api(`/agents/${config.agentId}/sessions`, {
      method: 'POST',
      body: { title: '桌宠对话' },
    });
    config.sessionId = session?.id ?? null;
    saveConfig();
    return config.sessionId;
  } catch {
    // 建会话失败不该阻塞聊天，退化成「无历史」模式
    return null;
  }
}

// ===========================================================================
// SSE 对话
// ===========================================================================

function emit(event) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('chat:event', event);
  }
}

/**
 * 调后端 SSE 接口，把每个事件转给渲染进程。
 *
 * ⚠️ 这里**不能用 fetch**：Electron 主进程的全局 fetch 读 text/event-stream 时会缓冲，
 * reader.read() 拿不到增量数据（实测一直挂到超时，而同一份请求用 Node 的 fetch 或 curl 都正常）。
 * 所以用 node:http / node:https 手写，data 事件是真正的增量推送。
 *
 * 另外 message 事件的 content 是**全量累积文本**（不是增量），
 * 前端直接覆盖显示即可，别做字符串拼接。
 */
async function streamChat(input, signal) {
  const token = getToken();
  if (!token) throw new Error('还没登录');
  if (!config.agentId) throw new Error('还没拿到平台助理信息，请点「重新连接」');

  const sessionId = await ensureSession();
  const payload = JSON.stringify({
    input,
    sessionId: sessionId ?? undefined,
    workspaceId: config.workspaceId ?? undefined,
  });

  const target = new URL(`${baseUrl()}/api/agents/${config.agentId}/chat/stream`);
  const isHttps = target.protocol === 'https:';
  const lib = isHttps ? https : http;

  await new Promise((resolve, reject) => {
    let settled = false;
    let idleTimer = null;
    /** @type {import('node:http').ClientRequest | null} */
    let request = null;

    const clearIdle = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    const settle = (error) => {
      if (settled) return;
      settled = true;
      clearIdle();
      if (request) {
        try {
          request.destroy();
        } catch {
          /* 已经关了 */
        }
      }
      if (error) reject(error);
      else resolve();
    };

    /**
     * 空闲兜底：一段时间没有新数据就认为本轮结束。
     *
     * 为什么要这个：在 Electron 主进程里读 SSE 时拿不到可靠的 EOF ——
     * 后端明明已经 response.end()（用 Node 原生 fetch 测 3 秒就 close），
     * 但这里 end / close / aborted 一个都不触发，会一直挂着不返回，
     * 表现就是「气泡一直在闪、输入框点不动」。
     *
     * 兜底提前结束的代价很小：只是说话动画早停，
     * 后续万一还有事件，onChatEvent 仍会照常更新气泡内容。
     */
    const armIdle = (ms) => {
      clearIdle();
      idleTimer = setTimeout(() => settle(null), ms);
    };

    request = lib.request(
      {
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        agent: false,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: `Bearer ${token}`,
          Accept: 'text/event-stream',
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;

        // 非 200：把 body 读完，尽量解析出可读文案
        if (status !== 200) {
          let raw = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            raw += chunk;
          });
          response.on('end', () => {
            let parsed = null;
            try {
              parsed = raw ? JSON.parse(raw) : null;
            } catch {
              /* 非 JSON */
            }
            const text = extractErrorMessage(parsed, status);
            const error = new Error(
              status === 401 ? unauthorizedMessage(text) : text,
            );
            error.status = status;
            settle(error);
          });
          response.on('error', settle);
          return;
        }

        let buffer = '';
        response.setEncoding('utf8');

        const drain = () => {
          const chunks = buffer.split('\n\n');
          buffer = chunks.pop() ?? '';
          for (const chunk of chunks) {
            const dataLine = chunk
              .split('\n')
              .find((line) => line.startsWith('data: '));
            if (!dataLine) continue;
            let event = null;
            try {
              event = JSON.parse(dataLine.slice(6));
            } catch {
              /* 单条解析失败跳过，不影响整条流 */
              continue;
            }
            emit(event);
            // 出字之后 token 很密，可以用短超时；其余阶段给长超时
            armIdle(
              event.type === 'message'
                ? SSE_IDLE_STREAMING_MS
                : SSE_IDLE_THINKING_MS,
            );
          }
        };

        response.on('data', (chunk) => {
          buffer += chunk;
          drain();
        });

        // 三个都可能是「结束」的信号，谁先来算谁的
        response.on('end', () => settle(null));
        response.on('close', () => settle(null));
        response.on('aborted', () => settle(null));
        response.on('error', settle);

        // 首字节之前也要有个上限，否则后端卡住就永远等下去
        armIdle(SSE_IDLE_THINKING_MS);
      },
    );

    request.on('error', (error) => {
      if (error.code === 'ECONNREFUSED') {
        settle(new Error(`连不上后端（${baseUrl()}），请先启动 backend 服务`));
        return;
      }
      settle(error);
    });

    if (signal) {
      const abort = () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        settle(error);
      };
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
    }

    request.write(payload);
    request.end();
  });
}

// ===========================================================================
// 窗口
// ===========================================================================

function clampPosition(x, y) {
  const displays = screen.getAllDisplays();
  const visible = displays.some((d) => {
    const b = d.workArea;
    return (
      x + WIN_W > b.x &&
      x < b.x + b.width &&
      y + WIN_H > b.y &&
      y < b.y + b.height
    );
  });
  if (visible) return { x, y };

  // 上次的位置已经不在任何屏幕上（拔了副屏 / 改了分辨率），回到右下角
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(area.x + area.width - WIN_W - 32),
    y: Math.round(area.y + area.height - WIN_H - 32),
  };
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  const saved = config.position;
  const pos = saved
    ? clampPosition(saved.x, saved.y)
    : {
        x: Math.round(area.x + area.width - WIN_W - 32),
        y: Math.round(area.y + area.height - WIN_H - 32),
      };

  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  // 'floating' 层级：盖住普通窗口，但不会盖住全屏游戏/演示
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    win.show();
    applyClickThrough(config.clickThrough);
  });

  win.on('closed', () => {
    win = null;
  });

  // 记住位置（拖拽结束时也会存，这里兜住系统移动窗口的情况）
  win.on('moved', () => {
    if (!win || win.isDestroyed()) return;
    const [x, y] = win.getPosition();
    config.position = { x, y };
    saveConfig();
  });
}

/** 穿透开关：ignore=true 时鼠标事件穿过透明区域；forward 让 mousemove 仍能进来 */
function applyClickThrough(ignore) {
  if (!win || win.isDestroyed()) return;
  if (ignoringMouse === ignore) return;
  ignoringMouse = ignore;
  if (ignore) {
    win.setIgnoreMouseEvents(true, { forward: true });
  } else {
    win.setIgnoreMouseEvents(false);
  }
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  win.show();
  win.setAlwaysOnTop(true, 'floating');
}

function toggleWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isVisible()) {
    win.hide();
  } else {
    showWindow();
  }
}

// ===========================================================================
// 托盘
// ===========================================================================

function buildTray() {
  const icon = nativeImage.createFromDataURL(
    `data:image/png;base64,${TRAY_ICON_B64}`,
  );
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('小蝶桌宠');

  refreshTrayMenu();
  tray.on('click', () => toggleWindow());
}

/**
 * 托盘菜单里也放一份语音开关。
 *
 * 桌宠是透明窗口，浮标按钮在右上角、面积不大，用户找不到开关时
 * 一般会去点托盘图标 —— 这里必须有同一份开关，且两边状态一致。
 */
function refreshTrayMenu() {
  if (!tray) return;

  const menu = Menu.buildFromTemplate([
    {
      label: '显示 / 隐藏小蝶',
      click: () => toggleWindow(),
    },
    {
      label: '语音播报',
      type: 'checkbox',
      checked: config.voiceEnabled !== false,
      click: (item) => {
        setVoiceEnabled(item.checked);
      },
    },
    {
      label: '重新连接',
      click: async () => {
        try {
          await fetchAssistantInfo();
          emit({ type: 'system', message: `已连接：${config.displayName}` });
        } catch (error) {
          emit({ type: 'system', message: `连接失败：${error.message}` });
        }
      },
    },
    { type: 'separator' },
    {
      label: '设置…',
      click: () => {
        if (!win || win.isDestroyed()) {
          createWindow();
          // 窗口刚建好时渲染进程还没绑好监听，等首屏加载完再推
          win.webContents.once('did-finish-load', () => emit({ type: 'open-panel' }));
        } else {
          showWindow();
          emit({ type: 'open-panel' });
        }
      },
    },
    {
      label: '打开网页版',
      click: () => shell.openExternal('http://localhost:5173'),
    },
    {
      label: '退出',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
}

/** 改语音开关的唯一入口：落盘 + 通知渲染进程 + 刷新托盘勾选状态 */
function setVoiceEnabled(enabled) {
  config.voiceEnabled = Boolean(enabled);
  saveConfig();
  if (win && !win.isDestroyed()) {
    win.webContents.send('tts:state', { voiceEnabled: config.voiceEnabled });
  }
  refreshTrayMenu();
}

// ===========================================================================
// IPC
// ===========================================================================

function registerIpc() {
  /** 渲染进程启动时拿一次全量状态 */
  ipcMain.handle('pet:state', async () => {
    let assistant = null;
    let error = null;
    if (getToken()) {
      try {
        assistant = await fetchAssistantInfo();
      } catch (err) {
        error = err.message;
        if (err.status === 401) {
          setToken(null);
          saveConfig();
        }
      }
    }
    return {
      baseUrl: config.baseUrl,
      email: config.email,
      loggedIn: Boolean(getToken()),
      displayName: config.displayName || '小蝶',
      petEnabled: config.petEnabled,
      clickThrough: config.clickThrough,
      voiceEnabled: config.voiceEnabled !== false,
      voiceId: config.voiceId || 'zh-CN-XiaoyiNeural',
      assistant,
      error,
    };
  });

  /**
   * 注意：handler 里**不要 throw**。
   * ipcRenderer.invoke 会把异常包成 "Error invoking remote method 'auth:login': Error: xxx"，
   * 用户看到的提示前面会挂一长串技术前缀。统一改成返回 { ok:false, error }。
   */
  ipcMain.handle('auth:login', async (_event, payload) => {
    const { email, password, baseUrl: newBase } = payload ?? {};
    if (newBase && String(newBase).trim()) {
      config.baseUrl = String(newBase).trim();
    }
    try {
      const data = await api('/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      setToken(data.accessToken);
      config.email = email;
      config.userId = data.user?.id ?? null;
      config.sessionId = null; // 换了账号，旧会话作废
      const assistant = await fetchAssistantInfo();
      saveConfig();
      return {
        ok: true,
        user: data.user,
        assistant,
        displayName: config.displayName,
      };
    } catch (error) {
      return { ok: false, error: error.message || '登录失败' };
    }
  });

  ipcMain.handle('auth:logout', () => {
    setToken(null);
    config.sessionId = null;
    config.agentId = null;
    config.displayName = '';
    saveConfig();
    return { ok: true };
  });

  ipcMain.handle('assistant:refresh', async () => {
    try {
      const assistant = await fetchAssistantInfo();
      return { ok: true, assistant, displayName: config.displayName };
    } catch (error) {
      return { ok: false, error: error.message || '连接失败' };
    }
  });

  ipcMain.handle('settings:save', (_event, payload) => {
    const { baseUrl: newBase, clickThrough } = payload ?? {};
    if (newBase && String(newBase).trim()) {
      config.baseUrl = String(newBase).trim();
    }
    if (typeof clickThrough === 'boolean') {
      config.clickThrough = clickThrough;
      applyClickThrough(clickThrough);
    }
    saveConfig();
    return { ok: true, clickThrough: config.clickThrough, baseUrl: config.baseUrl };
  });

  /**
   * 语音播报开关 / 音色切换。
   *
   * 语音开关是**本地偏好**（静音模式只出气泡不出声），不改人格配置；
   * 音色默认跟随人格，用户改了会写进本地 config。
   */
  ipcMain.on('tts:set-voice', (_event, payload) => {
    if (payload && typeof payload.voiceEnabled === 'boolean') {
      // 走统一入口，托盘勾选状态才不会和浮标按钮打架
      setVoiceEnabled(payload.voiceEnabled);
    }
    if (payload && typeof payload.voiceId === 'string' && payload.voiceId.trim()) {
      config.voiceId = payload.voiceId.trim();
      saveConfig();
    }
  });

  /**
   * 合成一句话，**直接把音频返回给渲染进程**。
   *
   * 返回音频（而不是走事件）是为了让渲染进程能「await 这一句合成 → 播这句 → 再下一句」，
   * 从而做到文字与语音逐句同步；事件方式会有时序竞争。
   *
   * 合成放主进程（本地 Edge TTS，失败回落后端），渲染进程只负责播放。
   */
  ipcMain.handle('tts:speak', async (_event, payload) => {
    const text = String(payload?.text ?? '').trim();
    if (!text) return { ok: false, empty: true };
    if (config.voiceEnabled === false) return { ok: false, muted: true };

    try {
      const buffer = await tts.synthesize(text, {
        voice: config.voiceId,
        api,
      });
      if (!buffer || buffer.length === 0) return { ok: false, error: '没有合成出音频' };
      return { ok: true, audio: buffer.toString('base64') };
    } catch (error) {
      return { ok: false, error: error.message || '语音合成失败' };
    }
  });

  ipcMain.handle('chat:send', async (_event, payload) => {
    const input = String(payload?.input ?? '').trim();
    if (!input) return { ok: false, error: '说点什么吧' };

    // 同一时刻只允许一条流，新的把旧的掐掉
    if (chatAbort) {
      try {
        chatAbort.abort();
      } catch {
        /* ignore */
      }
    }
    chatAbort = new AbortController();

    try {
      await streamChat(input, chatAbort.signal);
      return { ok: true };
    } catch (error) {
      if (error.name === 'AbortError') return { ok: false, aborted: true };
      if (error.status === 401) {
        setToken(null);
        saveConfig();
        emit({ type: 'auth:expired' });
        return { ok: false, error: '登录已过期，请重新登录' };
      }
      return { ok: false, error: error.message };
    } finally {
      chatAbort = null;
    }
  });

  ipcMain.on('chat:abort', () => {
    if (chatAbort) {
      try {
        chatAbort.abort();
      } catch {
        /* ignore */
      }
      chatAbort = null;
    }
  });

  ipcMain.on('pet:set-ignore-mouse', (_event, ignore) => {
    applyClickThrough(Boolean(ignore));
  });

  ipcMain.on('pet:drag-start', () => {
    if (!win || win.isDestroyed()) return;
    dragOrigin = win.getPosition();
  });

  ipcMain.on('pet:drag-move', (_event, { dx, dy }) => {
    if (!win || win.isDestroyed() || !dragOrigin) return;
    win.setPosition(
      Math.round(dragOrigin[0] + dx),
      Math.round(dragOrigin[1] + dy),
    );
  });

  ipcMain.on('pet:drag-end', () => {
    dragOrigin = null;
    if (!win || win.isDestroyed()) return;
    const [x, y] = win.getPosition();
    config.position = { x, y };
    saveConfig();
  });

  ipcMain.on('pet:focus-input', () => {
    if (!win || win.isDestroyed()) return;
    applyClickThrough(false);
    win.focus();
  });

  ipcMain.on('pet:hide', () => {
    if (win && !win.isDestroyed()) win.hide();
  });

  ipcMain.on('pet:quit', () => {
    app.isQuitting = true;
    app.quit();
  });

  ipcMain.on('shell:open', (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
  });
}

// ===========================================================================
// 生命周期
// ===========================================================================

/**
 * 交接文件必须在**拿单实例锁之前**就读掉。
 *
 * 为什么：桌宠已经开着时，用户再点一次「打开桌宠」，第二个进程会
 * `requestSingleInstanceLock()` 失败然后立刻退出 —— 它的环境变量
 * （`XIAODIE_HANDOFF` 指向新交接文件）传不到第一个实例，
 * 于是「换了个账号再点一次」这种场景会失效，文件也会烂在临时目录里。
 *
 * 所以第二个进程先把文件读进内存、随锁请求一起交给第一个实例
 * （`requestSingleInstanceLock(additionalData)` → `second-instance` 的第 4 个参数）。
 */
const pendingHandoff = consumeHandoff();

const gotLock = app.requestSingleInstanceLock({ handoff: pendingHandoff });
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, _argv, _cwd, additionalData) => {
    showWindow();
    // 只有真拿到新登录态才 reload，避免无意义地把气泡刷掉
    if (applyHandoffData(additionalData?.handoff) && win && !win.isDestroyed()) {
      win.webContents.reload();
    }
  });

  app.whenReady().then(() => {
    config = loadConfig();
    // 网页点「打开桌宠」时后端会把登录态放进交接文件，这里直接用它，
    // 用户不需要在桌宠里再登一次
    applyHandoffData(pendingHandoff);
    registerIpc();
    createWindow();
    buildTray();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });
}

// 桌宠常驻托盘：关窗口不退出（否则托盘还在、窗口没了会很困惑），
// 真正退出只走托盘菜单的「退出」→ app.quit()。
app.on('window-all-closed', () => {
  /* 故意留空 */
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (win && !win.isDestroyed()) {
    const [x, y] = win.getPosition();
    config.position = { x, y };
    saveConfig();
  }
});
