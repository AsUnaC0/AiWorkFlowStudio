# 01 - 桌宠客户端（Electron）

> 阅读本文后，你应该能回答：网页上的「打开桌宠」按钮怎么把本地程序拉起来？登录态怎么安全地送进桌宠？透明窗口怎么做到「点穿桌面、又点得中形象」？SSE 对话为什么不能用 fetch？语音播报怎么做到「边读边出字」？

相关代码路径：

```
desktop/src/main.js               ← Electron 主进程：窗口 / 托盘 / 配置 / 所有 HTTP 请求
desktop/src/preload.js            ← 主进程 ↔ 渲染进程的唯一桥（白名单方法）
desktop/src/renderer/index.html   ← 内联 SVG 形象 + 气泡 + 输入条 + 设置面板
desktop/src/renderer/pet.js       ← 渲染进程逻辑：命中测试 / 气泡 / 语音播报 / 拖拽
desktop/src/renderer/style.css    ← 透明窗口样式 + 全部 CSS 动画
desktop/src/tts.js                ← 本地 Edge TTS 合成（失败回落后端代理）
backend/src/desktop-pet/          ← 后端启动器（spawn 本机 Electron + 登录态交接文件）
fronted/src/api/desktopPet.ts     ← 网页侧 launchDesktopPet()
fronted/src/layout/components/AppHeader.vue  ← Header 右上角「打开桌宠」按钮
```

需求来源：[人格化与桌宠需求 v1.2](../需求/v1.5/16-人格化与桌宠需求_v1.2.md)、[接入实施方案 v1.0](../需求/v1.5/17-人格化与桌宠接入实施方案_v1.0.md)。后端启动器部分见 [后端 12 §11](../后端代码逻辑/12-人格与记忆模块.md)。

***

## 一、一句话理解

**桌宠 = 一个 340×480 的透明置顶 Electron 窗口；所有网络请求收口在主进程，渲染进程只负责画面与交互，token 永远不出主进程。**

```
┌─────────────── 主进程（Node 环境，main.js）───────────────┐
│ 窗口 / 托盘 / 配置文件（pet-config.json）                  │
│ fetch：/auth/login → /platform/assistant                  │
│        → /agents/:id/chat/stream（手写 node:http 读 SSE） │
│ token 只在这里（safeStorage 加密落盘）                     │
└───────────────────┬──────────────────────────────────────┘
                    │ IPC（preload.js 暴露白名单方法，只传事件，不传 token）
┌───────────────────▼──────────────────────────────────────┐
│ 渲染进程（renderer/）：SVG 形象 / 气泡 / 输入框 / 设置面板 │
└──────────────────────────────────────────────────────────┘
```

**为什么网络必须放主进程**：后端 `main.ts` 没有开 `enableCors()`，而渲染进程加载的是
`file://`（`Origin: null`），直接 `fetch` 会被同源策略拦掉。主进程跑在 Node 里，
没有同源策略这回事。副作用是好的：**token 不出主进程，页面脚本偷不到**。

***

## 二、启动链路：两条路，一条要绕后端

### 2.1 网页点开（推荐路径）

浏览器沙箱不允许网页启动本地程序，自定义协议（`xiaodie://`）开发期又常被拦，
所以走一条确定能通的路：**网页 → 后端接口 → 后端在本机 spawn Electron**。

```
AppHeader.vue「打开桌宠」按钮
   ↓ launchDesktopPet()                （fronted/src/api/desktopPet.ts）
POST /api/desktop-pet/launch            （带当前 JWT）
   ↓ DesktopPetService.launch()         （backend/src/desktop-pet/desktop-pet.service.ts）
   ├─ findDesktopDir()                  从 cwd 和 __dirname 各往上找 6 层 desktop/package.json
   ├─ resolveElectronBinary()           找 desktop/node_modules/electron/dist/electron.exe
   ├─ delete env.ELECTRON_RUN_AS_NODE   ★ 必删，否则 Electron 以纯 Node 模式启动直接崩
   ├─ writeHandoff()                    写 %TEMP%/xiaodie-handoff-<uuid>.json（0600，60s TTL）
   │                                    env.XIAODIE_HANDOFF 只放【文件路径】，不放 token
   └─ spawn(binary, ['.'], { cwd: desktopDir, detached: true, stdio: 'ignore' }) + unref()
```

三个必须照抄的细节（`DesktopPetService`）：

1. **目录靠探测不写死**：`npm run start:dev` 和 `node dist/src/main.js` 的 `__dirname` 层级不一样。
2. **必须** **`delete env.ELECTRON_RUN_AS_NODE`**：开发机预设了该变量，Electron 会以纯 Node 模式启动，
   报 `Cannot read properties of undefined (reading 'handle')` 后退出。
3. **`detached: true`** **+** **`unref()`**：桌宠要活过后端进程。

另有 3 秒防连点（`lastLaunchAt`）——注意它**不报错**，直接返回 `{ ok: true, message: '桌宠正在启动，稍等一下' }`，
让前端照常提示「正在启动」而不是弹红。真正的失败有三种，都是 503：找不到 `desktop/` 目录、依赖没装（`node_modules` 里没有 Electron）、
`spawn` 同步抛错。三条都带具体原因，不会「返回成功让人干等」。

> 重复点击不用怕：桌宠主进程有 `requestSingleInstanceLock()`，第二次启动会立刻退出、
> 并让第一个实例把窗口显示出来。所以这个按钮的语义天然就是「确保桌宠出现在屏幕上」。

### 2.2 命令行

```bash
cd desktop && npm start    # electron .
```

适用任何情况（包括后端在服务器上——此时网页按钮会 503，因为服务器上没有 `desktop/` 目录）。
缺点是走不到「登录态交接」，需要在桌宠面板里手动登录一次。

### 2.3 GPU 崩溃三连开关（`main.js` 顶部）

这台开发机（以及不少虚拟机 / 远程桌面 / 显卡驱动异常的 Windows）上，Electron 的 GPU
**子进程**一启动就崩：`GPU process exited unexpectedly: exit_code=-1073741819`，
连崩十几次后 `FATAL: GPU process isn't usable. Goodbye.` 直接退出——表现是 `npm start` 一闪而过。

只调 `app.disableHardwareAcceleration()` 不够（实测仍然崩），必须在 `app ready` 之前三件一起：

```js
app.commandLine.appendSwitch('no-sandbox');      // 受限环境里沙箱起不来
app.commandLine.appendSwitch('disable-gpu');     // 不用 GPU 做合成
app.commandLine.appendSwitch('in-process-gpu');  // 别再单独 fork GPU 子进程（崩的就是它）
app.disableHardwareAcceleration();
```

桌宠只有透明窗口 + CSS 动画 + 内联 SVG，软件合成完全够用，关掉反而更稳。

***

## 三、登录态交接：点开就是登录状态

用户是「先在网页登录，再点桌宠」的，桌宠不该再问一次密码。做法是**一次性交接文件**：

```
网页点按钮 → 后端写 %TEMP%/xiaodie-handoff-<uuid>.json
             { token, baseUrl, userId, email, expiresAt }（0600 权限，60s TTL）
   ↓ spawn 时 env.XIAODIE_HANDOFF 只放【文件路径】
桌宠启动 → consumeHandoff() 读文件 → 立即删除 → applyHandoffData() 并入 config
         → safeStorage 加密存 token → 后台拉 /platform/assistant
```

四个关键决定：

| 决定                     | 原因                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| **只传路径，不传 token 本身**   | 进程的命令行对同机任何用户都可见，`--token=xxx` 等于把 7 天有效的 JWT 公开；环境变量同理                                      |
| **文件 0600 + 60 秒 TTL** | 正常情况桌宠启动就读走并删掉；TTL 只兜底「spawn 失败 / 桌宠没起来」留下的垃圾（后端还挂了一个 `unref()` 的定时器做兜底清理）                   |
| **交接文件必须在拿单实例锁之前读**    | 见下方「单实例锁的交接顺序」                                                                               |
| **换账号才清旧数据**           | 用 `userId` 比对；不同则清 `agentId / displayName / workspaceId / sessionId / email`，否则会把上一个用户的会话串过来 |

> **读失败也要删**：`consumeHandoff()` 把 `fs.unlinkSync(file)` 写在 `finally` 里——不管是 JSON 坏了、过期了、还是根本读不出来，
> 文件都会被删掉。否则一份含 token 的文件会因为「解析失败」永久留在临时目录里，比不删更危险。

### 3.1 单实例锁的交接顺序（`main.js` 生命周期段）

这是全文件最容易写错的一段：

```js
const pendingHandoff = consumeHandoff();                       // ① 先读交接文件（拿锁之前！）

const gotLock = app.requestSingleInstanceLock({ handoff: pendingHandoff });  // ② 随锁请求带上
if (!gotLock) {
  app.quit();                                                  // ③ 第二个进程：退出
} else {
  app.on('second-instance', (_e, _argv, _cwd, additionalData) => {
    showWindow();                                              // ④ 第一个实例：显示窗口
    if (applyHandoffData(additionalData?.handoff) && win && !win.isDestroyed()) {
      win.webContents.reload();                                // ⑤ 真换了登录态才 reload
    }
  });
  app.whenReady().then(() => {
    config = loadConfig();
    applyHandoffData(pendingHandoff);                          // ⑥ 首进程直接应用交接
    registerIpc(); createWindow(); buildTray();
  });
}
```

**为什么必须先读再拿锁**：桌宠已开着时，用户再点一次「打开桌宠」，第二个进程
`requestSingleInstanceLock()` 失败会立刻退出——它的环境变量（`XIAODIE_HANDOFF` 指向新文件）
**传不到第一个实例**。于是「换了个账号再点一次」会失效，含完整 token 的文件还会烂在临时目录 60 秒。

修法就是上面这个顺序：第二个进程先把文件读进内存，随锁请求（`requestSingleInstanceLock(additionalData)`）
交给第一个实例；第一个实例在 `second-instance` 事件的**第 4 个参数**里拿到。
实测确认：不修会残留文件且换账号失效，修完残留归零。

`applyHandoffData()` 的返回值语义：只有「换了账号」或「token 真的变了」才返回 true——
同一个账号重复点按钮不该把页面刷掉（气泡会闪一下），换了才需要 `reload()`。

***

## 四、配置持久化与 token 保管

配置文件在 `app.getPath('userData')/pet-config.json`（Windows 下即
`%APPDATA%/XiaodiePet/pet-config.json`），`loadConfig()` 读不到就用 `defaults()`：

```js
{
  baseUrl: 'http://localhost:3000',
  tokenEnc: null,          // 加密后的 token（base64），优先使用
  tokenPlain: null,        // 明文 token —— 仅当系统不支持 safeStorage 时才落到这里
  email: '', userId: null, agentId: null, displayName: '',
  workspaceId: null, sessionId: null,
  position: null,          // 上次窗口位置 {x, y}
  clickThrough: true,      // 鼠标穿透开关
  petEnabled: true,
  voiceEnabled: true,      // 语音播报开关（本地偏好，关掉即静音模式）
  voiceId: 'zh-CN-XiaoyiNeural',
}
```

**token 用系统钥匙串（Windows DPAPI）加密后再落盘**：

```js
function setToken(token) {
  config.tokenPlain = null;
  config.tokenEnc = null;
  if (!token) return;
  if (safeStorage.isEncryptionAvailable()) {
    config.tokenEnc = safeStorage.encryptString(token).toString('base64');
    return;
  }
  config.tokenPlain = token;   // 兜底：系统不支持才明文
}
```

> ⚠️ 桌宠只保存 token，不保存密码（登录面板的 tip 文案也这么写）。token 过期（7 天）后
> 点形象重新登录即可。

**窗口位置回正**：`clampPosition()` 校验上次坐标是否仍落在**任一**屏幕的 `workArea` 内，
不在（拔了副屏 / 改了分辨率）就回主屏右下角——否则桌宠会「跑到屏幕外找不回来」。

***

## 五、IPC 白名单：渲染进程能做什么

`preload.js` 用 `contextBridge.exposeInMainWorld('pet', {...})` 暴露唯一入口，
**只暴露白名单方法**，渲染进程连 `baseUrl` 之外的东西都拿不到：

| 分组    | 方法                                                                                                        | 方向                                 |
| ----- | --------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 状态与账号 | `getState()` / `login()` / `logout()` / `refreshAssistant()` / `saveSettings()`                           | invoke → handle                    |
| 对话    | `send(input)` / `abort()` / `onChatEvent(cb)`                                                             | invoke / send / 主→渲染推 `chat:event` |
| 语音    | `speak(text)` / `setVoice(payload)` / `onVoiceState(cb)`                                                  | invoke / send / 主→渲染推 `tts:state`  |
| 窗口行为  | `setIgnoreMouse` / `dragStart` / `dragMove` / `dragEnd` / `focusInput` / `hide` / `quit` / `openExternal` | send（单向）                           |

**两个约定必须记住**：

1. **handler 里不要 throw**。`ipcRenderer.invoke` 会把异常包成
   `"Error invoking remote method 'auth:login': Error: xxx"`，用户看到的提示前面挂一长串技术前缀。
   所以主进程所有 handler 统一返回 `{ ok: false, error }`；渲染进程的 `cleanError()` 再剥一层前缀做兜底。
2. **`tts:speak`** **返回音频而不是推事件**——为了让渲染进程能
   「await 这一句合成 → 播这句 → 再下一句」，做到文字与语音逐句同步；事件方式会有时序竞争。

主进程 `chat:send` 同一时刻只允许一条流：新消息会把旧的 `AbortController` 掐掉
（`chatAbort.abort()`），渲染进程据此显示「（已取消）」。

### 5.1 错误文案链路：为什么用户看不到 `fetch failed`

「handler 不 throw」只解决了 IPC 这一层。再往下，`fetch` 本身抛的是 `TypeError: fetch failed`
这类技术文案，直接透到气泡里等于没做提示。所以主进程的 `api()` 分三段翻译：

```js
async function api(pathname, { method = 'GET', body, timeout = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);   // ① 20s 硬超时
  try {
    const res = await fetch(`${baseUrl()}/api${pathname}`, { ..., signal: controller.signal });
    const text = await res.text();          // ② 先读完整 body 再解析（错误响应也读得到）
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }   // 非 JSON 就留原文
    if (!res.ok) {
      const raw = extractErrorMessage(data, res.status);
      const error = new Error(res.status === 401 ? unauthorizedMessage(raw) : raw);
      error.status = res.status;            // ★ 401 靠这个字段被上层识别
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('请求超时：后端没响应，检查服务是否已启动');
    if (error instanceof TypeError && /fetch failed/i.test(error.message)) {
      throw new Error(`连不上后端（${baseUrl()}），请先启动 backend 服务，或在设置里改服务地址`);
    }
    throw error;
  } finally { clearTimeout(timer); }
}
```

**`extractErrorMessage()`** **按五级优先级猜错误字段**——本项目的 `AllExceptionsFilter` 返回
`{ statusCode, error, message }`，但撞上别的服务（比如端口被别的程序占了）可能是
`{ status, retcode, data, wording }`：

```js
const candidates = [data.message, data.error, data.wording, data.msg, data.data && data.data.message];
```

字符串取第一个非空的；数组（class-validator 的报错是字符串数组）用 `；` 拼起来；
全都没有才回退 `HTTP ${status}`。

**`unauthorizedMessage()`** **把 401 的英文/空文案换成中文**：`unauthorized`、`HTTP 401`
这类统一变成「邮箱或密码不正确（也可能是服务地址指向了别的后端）」——后半句很重要，
桌宠面板里 `baseUrl` 是可编辑的，指错端口时后端返回的就是 401 而不是连接失败。

**401 的两处清 token 行为**（不只是提示）：

| 位置 | 行为 |
| --- | --- |
| `pet:state`（启动时拉状态） | `err.status === 401` → `setToken(null)` + `saveConfig()`，随后返回 `error` 字段；渲染进程 `boot()` 看到 `info.error` 会 `state.loggedIn = false` 并自动弹面板 |
| `chat:send`（对话中） | 401 → `setToken(null)` + 推 `auth:expired` 事件；渲染进程收到后置未登录、气泡提示「登录过期了，点我重新登录」、自动开面板 |

`auth:login` 成功后还有一条容易漏的清理：**`config.sessionId = null`**（换账号，旧会话作废）。
不清的话新账号的第一句话会发进上一个账号的会话里。`auth:logout` 同样清
`sessionId` / `agentId` / `displayName`。

***

## 六、对话流：SSE 为什么不能用 fetch

### 6.1 主进程手写 node:http 读 SSE（`streamChat`）

⚠️ **这里不能用 fetch**：Electron 主进程的全局 `fetch` 读 `text/event-stream` 时会缓冲，
`reader.read()` 拿不到增量数据（实测一直挂到超时，而同一份请求用 Node 的 fetch 或 curl 都正常）。
所以用 `node:http` / `node:https` 手写，`data` 事件是真正的增量推送。

解析就是标准的 SSE 切包：

```js
response.on('data', (chunk) => {
  buffer += chunk;
  const chunks = buffer.split('\n\n');   // SSE 以空行分帧
  buffer = chunks.pop() ?? '';           // 最后半截留下次
  for (const chunk of chunks) {
    const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
    const event = JSON.parse(dataLine.slice(6));   // 单条解析失败跳过，不影响整条流
    emit(event);                          // 转发给渲染进程
    armIdle(event.type === 'message' ? 5000 : 90000);   // 见下
  }
});
```

**非 200 要先读完整个 body 再解析**：SSE 请求失败时后端返回的是普通 JSON
（`{ statusCode, message }`），不是事件流。这时不能按 `\n\n` 切帧，而要
`res.on('data')` 攒起来、`res.on('end')` 里整体 `JSON.parse` 再喂给
`extractErrorMessage()` + `unauthorizedMessage()`（见 §5.1），最后 `settle` 一个带
`ok: false, error` 的结果给渲染进程。顺序反了（先切帧再解析）会得到一堆半截 JSON。

### 6.2 空闲兜底：分档计时器

在 Electron 主进程里读 SSE 拿不到可靠的 EOF——后端明明已经 `response.end()`
（用 Node 原生 fetch 测 3 秒就 close），但这里 `end` / `close` / `aborted` 一个都不触发，
会一直挂着不返回，表现是「气泡一直在闪、输入框点不动」。

所以必须自己按**空闲时间**兜底，且分两档（两种阶段的「正常静默」差别很大）：

| 阶段                           | 阈值      | 理由                                        |
| ---------------------------- | ------- | ----------------------------------------- |
| 思考 / 调工具（含 `reasoning` 推理过程） | **90s** | 模型可能几十秒不吐字；思考型模型的推理可能持续几十秒且期间没有 `message` |
| 已出字之后（`message` 事件）          | **5s**  | token 间隔通常 50\~200ms，几秒没动静就是真的结束了         |

兜底提前结束的代价很小：只是说话动画早停，后续万一还有事件，`onChatEvent` 仍会照常更新气泡。
但阈值给小了会把「模型首 token 慢」误判成结束——表现成只收到 `meta` / `thinking` 就断流、
气泡停在 `…`。

### 6.3 渲染进程消费事件（`pet.js` 的 `onChatEvent`）

| 事件                                                 | 桌宠的反应                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| `meta`                                             | 带 `personaName` 就更新显示名（人格改名立即生效）                                   |
| `thinking`                                         | 头部摇摆加速（`.thinking` 类把摇摆周期 5.4s 压到 1.6s）                            |
| `reasoning`                                        | **不展示内容**（气泡太小），但必须保持 `thinking` 动画——推理可能几十秒没有 `message`，不处理会像卡死   |
| `tool_call`                                        | 气泡显示「正在跑工作流…」这类短句（`TOOL_LABELS` 表把 16 个工具名翻成中文动作）                  |
| `tool_result`                                      | 摘掉 `thinking`                                                      |
| `message`                                          | 语音开 → `handleVoiceStream()` 逐句切分；语音关 → `setBubbleStreaming()` 直接覆盖 |
| `operation`                                        | 只看 `status === 'FAILED'`，气泡提示哪个操作没成功                               |
| `file`                                             | 气泡提示「文件做好了：xxx（去网页版我的文件下载）」                                        |
| `error` / `auth:expired` / `system` / `open-panel` | 错误气泡 / 弹出登录面板 / 系统提示 / 托盘「设置…」推来开面板                                |

> **`message`** **事件的** **`content`** **是全量累积文本，不是增量**。如果按增量拼字符串会得到重复内容，
> 直接覆盖显示才对（`setBubbleStreaming`）。

***

## 七、语音播报：边读边出字

### 7.1 合成：本地优先，失败回落（`desktop/src/tts.js`）

```
synthesize(text, { voice, api })
   ├─ voice 以 voc_ 开头？──→ 走后端 /tts/synthesize（BreezeBlue 密钥在后端，本地合成不了）
   ├─ 本地刚失败过（60s 冷却内）？──→ 直接走后端，省一次本地超时
   └─ 本地 Edge TTS（msedge-tts 库，连微软服务，无需密钥）
        └─ 失败 → localBrokenUntil = now + 60s → 回落后端
             └─ 后端也失败 → 返回 null（不抛错！只出气泡不出声，绝不影响对话）
```

两个选型细节：

- 用 `msedge-tts` 而不是 `edge-tts`：微软当前要求 Sec-MS-GEC **v2** 令牌，
  `edge-tts@1.0.x` 只发 v1 会 403；`msedge-tts` 已实现 v2 并能自动校正时钟偏差。
- **本地失败一次就进入 1 分钟冷却**：否则微软服务不通时每条消息都卡一次本地超时，体验致命。

音色默认跟随人格配置（`fetchAssistantInfo()` 里 `config.voiceId = info.persona?.voiceId`），
用户在桌宠设置里改了会写进本地 config；`voc_` 前缀的 BreezeBlue 音色强制走后端合成。

### 7.2 播放：逐句切分 + 打字机同步（`pet.js`）

需求是「文字与语音同步，边读边出字」。做法是把回复按句子切开，
逐句「合成 → 播放 → 播到哪句就把哪句写进气泡」：

```
message 事件（全量累积文本）
   ↓ handleVoiceStream(text)
   ├─ 找到最后一个句末标点（。！？!?\n），把之前的完整句切出去 enqueueSentences()
   │     └─ 太长的句子再按逗号切一刀（splitLong，limit=45，切点是自然停顿）
   ├─ prefetchNext()   预取下一句（最多并行 2 条合成，减少句间空白）
   ├─ pumpSpeech()     播放泵：队首没合成好就先合成（合成完会再叫醒本泵）
   └─ flushTimer 700ms 静默兜底：把剩下的半句也切出去（flushVoiceRemainder）

pumpSpeech() 播当前句时：
   playBase64Audio(base64, onStart, epoch)
      └─ onStart(duration) → startTypewriter(sentence, duration)
           按【音频真实时长】把这句话一个字一个字补进气泡
```

**打字机按真实经过时间算进度，不是每 tick 累加固定字数**：

```js
// setInterval 本身会漂移（每 tick 晚几毫秒，一秒积几十毫秒），
// 累加写法会让句末文字比声音慢半拍
const ratio = Math.min(1, (Date.now() - startAt + tickMs) / durationMs);
const shown = Math.min(total, Math.max(1, Math.floor(total * ratio)));
```

（`+tickMs` 是给个提前量：开口瞬间就先蹦出第一个字，不要先空 40ms。）
音频先于文字播完（或被打断）时由 `finishTypewriter()` 把整句补全。

**`speechEpoch`** **代次**：每次重置 / 关闭语音都 `speechEpoch++`，所有异步回调
（合成返回、音频解码、打字机 tick）都带着自己那一代的 epoch，回来后比对不等就丢弃——
否则上一轮的语音回调会把新一轮对话的气泡覆盖掉。

**关语音时不清内容**：`abortSpeechAndShowAll()` 停声、清队列，但把整段文字补齐显示
（剥过 markdown 标记），别让内容丢了。

**气泡与合成都用剥过标记的文本**（`stripMarkdown`）：不剥掉 `**` / `` ` `` / 标题井号，
用户就会看到「我叫\*\*小蝶\*\*」，语音合成那边也会把星号当停顿读。

### 7.3 开关的两处 UI 必须一致

语音开关同时存在于**浮标按钮**（右上角小喇叭）和**托盘菜单**（checkbox）。
改开关只走 `setVoiceEnabled()` 一个入口：落盘 + 推 `tts:state` 给渲染进程 + 刷新托盘勾选。
渲染进程收到 `tts:state` 只更新 UI 不再回写，避免来回弹。

***

## 八、鼠标穿透：用坐标判定，不能用 `e.target`

桌宠窗口 340×480，但视觉上只有形象和气泡那一小块是实体，其余透明。
窗口开了 `setIgnoreMouseEvents(true, { forward: true })`——透明处点穿到桌面。

**坑**：`forward: true` 转发进来的 mousemove **不做命中测试**，`event.target` 通常是
`<html>`，用 `closest('.hit')` 永远判不到形象上，表现是「鼠标移过去也点不中、拖不动」。

正确做法是拿坐标比矩形（`pet.js`）：

```js
function hitTest(clientX, clientY) {
  for (const el of [bubble, petWrap, inputbar, panel, topControls]) {
    if (!el || el.hidden) continue;
    const r = el.getBoundingClientRect();
    if (clientX >= r.left && clientX <= r.right &&
        clientY >= r.top  && clientY <= r.bottom) return true;
  }
  return false;
}
```

外层包了两个细节：

- `mousemove` 里用 `requestAnimationFrame` 合帧（`rafPending`），每帧最多算一次命中；
- `forceInteractive` 状态：输入框或面板打开时强制窗口可交互（否则点不到输入框）。
  `applyMouseThrough()` 里 `ignore = forceInteractive ? false : !hitTest(...)`，
  且只在结果变化时才发 IPC（`lastIgnore` 去重），不重复刷 `setIgnoreMouseEvents`。

不同 Windows 版本对 `forward` 的支持有差异，所以设置面板里留了「鼠标穿透」开关，
关掉就退化成普通可点窗口（`pet:focus-input` 也会临时关掉穿透再 `win.focus()`）。

***

## 九、形象与动画：内联 SVG，不用图片素材

| 方案           | 问题                                         |
| ------------ | ------------------------------------------ |
| PNG 立绘       | 透明背景要自己抠；换配色要重画；体积大                        |
| Live2D       | 要模型文件 + `pixi-live2d-display`，属 P3，MVP 用不上 |
| **内联 SVG** ✅ | 真透明、零素材、配色就是几个 `fill` 值                    |

形象在 `renderer/index.html` 里：后发、两侧垂发、连衣裙、领结、小手、刘海、眼睛、腮红、嘴、
蝴蝶结发饰，全部 `<path>` / `<ellipse>` 手绘，配色走渐变（`hairGrad` / `dressGrad` / `faceGrad`）。

四组动画全是 CSS，不需要 JS 逐帧算：

| 效果   | 实现（style.css）                                                                  |
| ---- | ------------------------------------------------------------------------------ |
| 呼吸   | `.pet-root` 的 `scale(0.994, 1.018)`，3.6s，`transform-origin` 在脚底（`100px 190px`） |
| 头部摇摆 | `.head` 的 `rotate(±1.4deg)`，5.4s                                               |
| 眨眼   | `.eyes` 的 `scaleY(0.06)`，5.2s 里只在 94%\~96% 发生                                  |
| 说话   | `.pet-root.talking .mouth` 的 `scale(1.12, 2.1)`，0.26s 交替                       |
| 思考   | `.pet-root.thinking .head` 把摇摆周期从 5.4s 压到 1.6s                                 |
| 拖拽   | `.dragging` 停掉呼吸（免得抖），整体 `rotate(-4deg) scale(1.03)` 像被拎起来                     |

> ⚠️ `transform-origin` 要用 **viewBox 用户坐标**（如 `100px 190px`），并且必须配
> `transform-box: view-box`。只写 `transform-origin: bottom center` 在 SVG 里不生效。

**拖拽与点击的区分**：`pointerdown` 记 `screenX/screenY` 并 `api.dragStart()`
（主进程记下窗口起点 `dragOrigin`）；`pointermove` 位移 > 4px 才算拖拽，
调 `api.dragMove(dx, dy)` 由主进程 `win.setPosition()` 移窗；`pointerup` 没拖过就当点击
（`onPetClick`：未登录开面板，已登录切换输入框）。窗口移动后 `win.on('moved')` 与
`pet:drag-end` 都会把位置写回 config。

***

## 十、和网页版共享什么、不共享什么

| 项     | 共享 | 说明                                                                    |
| ----- | -- | --------------------------------------------------------------------- |
| 账号    | ✅  | 同一个 `/auth/login`，同一个 JWT                                             |
| 人格    | ✅  | 都从 `GET /platform/assistant` 取 `displayName`；音色也默认跟随人格                |
| 记忆    | ✅  | 桌宠的对话同样走 `runStream`，结束后同样触发沉淀，网页版星图里能看到                              |
| 会话    | ❌  | 桌宠首次说话时自建一个标题为「桌宠对话」的会话（`ensureSession()`），不污染网页版聊天记录                 |
| 工具与审计 | ✅  | 走的是同一套 `PlatformToolsService`，19 个工具、风险确认、`PlatformOperationLog` 全都照旧 |

**没有任何一条能力是「桌宠专用」的旁路**——这是有意的：桌宠只是个壳，
后端看不到「请求来自桌宠」这件事，也就没法出现「桌宠能绕过确认」这种漏洞。

`ensureSession()` 建会话失败不该阻塞聊天——catch 掉退化成「无历史」模式
（`sessionId` 为 undefined，后端按无会话处理）。

***

## 十一、常见坑

1. **启动就白屏 / 什么都不显示** —— 先看后端在不在（默认 `http://localhost:3000`）。
   渲染进程拿不到状态时会弹设置面板，面板里会写具体错误。
2. **一闪而过、进程直接退** —— GPU 子进程崩了。确认 `main.js` 顶部三个 switch +
   `disableHardwareAcceleration()` 都在 `app ready` 之前调用（见 §2.3）。
3. **`Cannot read properties of undefined (reading 'handle')`** —— 环境变量
   `ELECTRON_RUN_AS_NODE` 没删。这条是后端 spawn 时删；如果你是手动起桌宠，先清掉它。
4. **点不中、拖不动** —— 鼠标穿透在作怪，设置里关掉它；并检查命中判定用的是坐标比矩形
   而不是 `e.target.closest()`（见 §八）。
5. **登录成功但一发消息就 401** —— token 过期（7 天）。点形象重新登录。
   主进程对 401 会清掉本地 token 并推 `auth:expired` 事件（见 §5.1）。
6. **提示里带** **`Error invoking remote method 'xxx'`** **前缀** —— 某个 IPC handler 里
   `throw` 了。handler 必须统一 `return { ok: false, error }`；渲染进程的 `cleanError()`
   只能剥掉这层前缀做兜底，根治要在主进程改（见 §五）。
7. **气泡文字一闪就没了 / 内容重复** —— `message` 事件的 `content` 是**全量累积文本**，
   按增量拼字符串会重复；直接覆盖才对（`setBubbleStreaming`）。
8. **拖到副屏后重启跑到屏幕外** —— 主进程 `clampPosition()` 会校验坐标是否落在
   任一屏幕的 `workArea` 内，不在就回右下角（见 §四）。
9. **关掉窗口后找不到小蝶** —— 点窗口关闭只是隐藏（`window-all-closed` 故意留空，
   进程常驻托盘），去托盘左键点一下；真正退出只走托盘菜单的「退出」。
10. **气泡一直在闪、输入框点不动** —— SSE 空闲兜底没生效或阈值不对。思考阶段 90s、
    出字后 5s 分档，`reasoning` 也必须按 90s 那一档重置计时器（见 §6.2）。
11. **回复说完了光标还在闪** —— 光标是「还在说话」的信号，`sendMessage` 的 `finally`
    里必须 `stopBubbleCursor()`，否则按钮都恢复了气泡末尾还在闪，看起来像卡住。
12. **语音对不上字** —— 打字机进度必须按 `Date.now()` 真实经过时间算，不能每 tick
    累加固定字数（`setInterval` 会漂移，见 §7.2）。
13. **每句话都卡一下才有声音** —— 本地 Edge TTS 不通且没进冷却。确认 `tts.js` 的
    60 秒 `localBrokenUntil` 逻辑在；微软服务长期不通就改用 `voc_` 前缀的 BreezeBlue 音色
    （强制走后端合成）。
14. **连不上后端却只提示「出错了」** —— `api()` 里 `AbortError` / `fetch failed` 两条
    翻译被删了，用户就看不到「后端没启动」和「服务地址不对」的区别（见 §5.1）。

***

## 十二、已知边界

| #  | 边界                                    | 影响                                                                 |
| -- | ------------------------------------- | ------------------------------------------------------------------ |
| D1 | 桌宠 MVP 直接复用 7 天有效的 JWT                | `DesktopPetSettings` / `RefreshToken` 两张表只有表结构，没有接口读写；token 过期只能重新登录 |
| D2 | 语音开关是**本地偏好**                         | 不改人格配置；换一台机器要重新设置                                                  |
| D3 | 气泡没有 markdown 渲染                      | 代码块、表格在气泡里以纯文本显示（剥过标记）；复杂排版请去网页版看                                  |
| D4 | 托盘菜单「打开网页版」写死 `http://localhost:5173` | **当前是坏的**：`vite.config.ts` 里 `server.port = 5175`，点这一项打不开页面。要改 `main.js` 的 `refreshTrayMenu()`，更好的做法是读 `config.baseUrl` 或加配置项 |
| D5 | 后端在服务器上时网页按钮不可用                       | `DesktopPetService` 找不到 `desktop/` 目录会返回 503 并说明原因；此时用命令行启动 + 手动登录 |
| D6 | 桌宠没有「开机自启」                            | 要常驻只能把 Electron 快捷方式放进系统启动目录；`DesktopPetSettings` 表没有对应接口 |

