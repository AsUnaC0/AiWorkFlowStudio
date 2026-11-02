# AI WorkFlow Studio — 前端代码逻辑文档

> 面向**小白开发者**的前端代码讲解文档，按功能面拆分，覆盖每一处关键交互的入口、数据流、实现细节与踩坑记录。
> 与 [../后端代码逻辑](../后端代码逻辑/README.md) 互为姊妹篇：后端讲「数据怎么来」，这里讲「画面怎么画」。

---

## 文档目录

本套文档只覆盖两块「前端里最不像普通 Vue 页面」的实现——桌面端（Electron 主/渲染双进程）与 3D 星图（Three.js 手写 shader）。常规页面（登录、聊天、配置、工作流、知识库、模型、Skills/MCP、好友、控制台）与 `docs/需求/` 里的交互描述一一对应，不单独成册。

| 序号 | 文件 | 覆盖范围 | 读完你应该能回答 |
|---|---|---|---|
| 01 | [桌宠客户端（Electron）](./01-桌宠客户端-Electron.md) | desktop/src/main.js / preload.js / renderer/（index.html + pet.js + style.css）/ tts.js / 后端 desktop-pet 启动器 / 前端 launchDesktopPet | 网页怎么点开本地桌宠？token 怎么安全送进 Electron？透明窗口怎么做到「点穿桌面但点得中形象」？SSE 为什么不能用 fetch？语音怎么做到边读边出字？ |
| 02 | [记忆星图页面](./02-记忆星图页面.md) | views/memory/index.vue / components/memory/MemoryPanel.vue / MemoryGraph.vue / api/memory.ts / 路由与入口 | 记忆页入口藏在哪、为什么？星图的四层结构分别是什么？确定性布局怎么做到刷新不重排？悬停/点击/过滤的视觉状态怎么算？为什么列表接口不带原文？ |
| 03 | [界面操作桥接](./03-界面操作桥接.md) | modules/ui-control/（registry / executor / browser-bridge / page-catalog / page-registration）/ api/uiControl.ts | AI 怎么"带着用户操作浏览器"？Registry 三份数据 + 两条边界怎么保证安全？长轮询怎么选对标签页？执行结果怎么做到"不是假设成功"？ |

---

## 代码路径约定

文中所有 `fronted/src/xxx`、`desktop/src/xxx` 路径均相对于项目根目录 `c:\Users\meibus\Desktop\AI WorkFlow Studio`（`fronted` 就是前端目录名，不是拼写错误）。

## 推荐阅读顺序

想了解桌宠 → **01**（桌面端全链路：启动 → 登录态交接 → 对话 SSE → 语音播报 → 鼠标穿透）

想了解记忆可视化 → **02**（入口 → 接口约定 → 面板状态机 → 四层渲染 → 交互）

想了解 UI Control 界面操作 → **03**（Registry / Executor / Browser Bridge / 会话与路由守卫）

**UI Control 需要先读后端 11 §八·一**（平台助理 UI 工具组与 UIActionBridgeService），
然后回来看前端 03 知道执行链怎么落地。桌宠（01）→ UI Control（03）→ 后端（11）这三块是同一条能力链。

三篇互不依赖，可以分开读。都要读的话建议先 01 后 02：01 讲的是「进程边界」，02 讲的是「渲染管线」，前者是理解后者的前提（比如为什么星图页面完全没有 IPC 这一层）。03 是独立的「前后端协作」主题，和桌面端 / 星图的技术栈都不一样。

---

## 与后端文档的分工

| 话题 | 后端文档 | 本文档 |
|---|---|---|
| 记忆怎么沉淀 / 召回 / 打分 | [12 - 人格与记忆模块](../后端代码逻辑/12-人格与记忆模块.md) §六 | 02（只看「怎么展示」） |
| 桌宠启动器（`DesktopPetService`） | [12 §11](../后端代码逻辑/12-人格与记忆模块.md)（spawn / 交接文件） | 01（Electron 侧拿到交接后做什么） |
| TTS 双引擎（Edge + BreezeBlue） | [08 第九节](../后端代码逻辑/08-MCP-Skill-Storage-其他模块.md) | 01 §七（桌宠本地合成与回落） |
| SSE 事件由谁发出 | [04 - Agent 智能体模块](../后端代码逻辑/04-Agent智能体模块.md) | 01 §六（桌宠主进程怎么读流） |

---

## 本文档的准确性说明

两篇均已对照 `desktop/src/**` 与 `fronted/src/**` 逐文件核验（`main.js` 1055 行、`preload.js` 48 行、`tts.js` 109 行、`renderer/pet.js` 1036 行、`MemoryPanel.vue` 894 行、`MemoryGraph.vue` 1116 行、`api/memory.ts` 125 行、后端 `desktop-pet` 两个文件）。校验分三类：**数字**（阈值 / 半径 / 配色 / 行数）、**名称**（变量 / 函数 / 事件 / 接口路径）、**行为**（调用顺序 / 分支条件 / 失败降级）。

### 修订记录

| # | 位置 | 修订内容 |
|---|---|---|
| 1 | 01 §2.1 | 「两个 503 分支」表述不准，实际是**三个**（找不到 `desktop/` 目录 / 依赖未装 / `spawn` 同步抛错）；而 3 秒防连点**不是** 503，直接返回 `ok: true` |
| 2 | 01 §十二 D4 | 托盘「打开网页版」写死 `http://localhost:5173`，而 Vite 实际端口是 **5175**——这条不是「改了端口要同步」而是**当前就是坏的** |
| 3 | 01 §三 | 补充「交接文件读失败也会被删」的细节（`consumeHandoff` 把 `unlinkSync` 放在 `finally`） |
| 4 | 01 §5.1 | **新增**「错误文案链路」：`api()` 的 20s 超时、`extractErrorMessage()` 五级字段兜底、`unauthorizedMessage()` 的 401 中文翻译、两处 401 清 token 行为、`auth:login` 清 `sessionId` |
| 5 | 01 §6.1 | 补充「非 200 要先读完整个 body 再解析」——SSE 请求失败返回的是普通 JSON，按 `\n\n` 切帧会得到半截 JSON |
| 6 | 01 §十一 | 坑从 12 条扩到 14 条（新增「IPC 前缀泄漏」「连不上后端却只说『出错了』」两条） |
| 7 | 02 §五 | **新增**组件契约小节：`props` / `emit` / 三输入视觉状态 / 五张内部大表（`indexById` / `neighborsOf` / `linkMeta` / `linkBaseAlpha` / `baseColors`） |
| 8 | 02 §5.1 | **新增**相机与 `OrbitControls` 参数表（`50/0.1/400`、`(0,16,23)`、damping `0.06`、`rotateSpeed 0.55`、`8/90`、`autoRotateSpeed 0.22`） |
| 9 | 02 §5.8 | 原写「节点数为 0 时不建 Three 场景」是错的——`init()` 照建 renderer / scene / camera / composer，`buildBackgroundStars()` 也照跑，只是 `rebuild()` 在 `nodeList.length === 0` 时提前 return |
| 10 | 02 §三 | `MEMORY_CATEGORY_LABELS` 的真实用途是**悬停标签的分类名**（`updateTip()`），不是「接口没返回 `categoryLabel` 的兜底」；`getMemoryCategories()` 已封装但**全项目无人调用**（死代码） |
| 11 | 02 §六 | 坑从 9 条扩到 11 条（新增「相机被放平导致星图扁成一坨」「`minDistance` 太小会钻进星团」） |
| 12 | **新增 03** | `fronted/src/modules/ui-control/` 与 `fronted/src/api/uiControl.ts` 此前**完全没有文档**。补齐「Registry 三份数据 + 两条边界」「Executor 四种操作」「Browser Bridge 长轮询主循环」「会话 ID 用 sessionStorage 隔离 tab」「路由守卫导致的 ROUTE_MISMATCH 必须重新读路由」等关键实现。与后端 11 §八·一 形成对照：后端讲 UIActionBridgeService，前端 03 讲 Registry / Executor / Bridge。 |

---

## 已知实现缺口（文档已标注，代码尚未修）

只有一条落在本套文档的覆盖范围内：

| # | 缺口 | 影响 |
|---|---|---|
| D4 | 桌面端托盘「打开网页版」指向 `localhost:5173`，Vite 实际监听 **5175** | 点托盘这一项打不开页面（连不上）。改 `main.js` 的 `refreshTrayMenu()`，更好的做法是读 `config.baseUrl` 或加配置项。详见 01 §十二 |

其余边界（语音开关是本地偏好、气泡没有 markdown 渲染、后端在服务器上时网页按钮不可用、没有开机自启等）见 01 §十二 D1~D6；记忆侧的 5 条边界（只能删不能改、最多渲染 500 节点等）见 02 §七 F1~F5。
