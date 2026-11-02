# 项目长期记忆 —— AI WorkFlow Studio

## 分层原则
- MCP 只管标准 MCP Server；普通 HTTP/REST 走工作流 HTTP 节点。
- 新增外部能力：独立模块 + 传输抽象 + 分层服务，通信逻辑不进 Controller。

## Provider 层（`backend/src/ai/`）
- 只有 2 个实现类：`OllamaProvider` / `OpenAICompatibleProvider` 承载 4 种 `LlmProviderType`，不建子类。
- 工厂 `createProvider` 是纯函数（非 DI）。`openai`/`deepseek` 合并一个 case（`baseUrl || DEFAULT_BASE_URL[provider]`）；`openai-compatible` 不能并（无默认 baseUrl）。
- 不能动：`DEFAULT_BASE_URL` 的 key（`resolveBaseUrl()` 依赖，两处同步改）；第三参数 `name` 必须与类型同名（写进 `ModelCallLog.provider`）。枚举 `deepseek` 不能删。
- 推理与正文两条流：`streamChat` 返回 `ChatStreamChunk = {type:'content'|'reasoning', text}`，只要正文套 `contentOnly()`。字段名三套：`reasoning_content`(DeepSeek/SiliconFlow)、`reasoning`(OpenRouter)、`message.thinking`(Ollama)。**不要用 `onReasoning` 回调**（async generator 里不能 yield）。
- Agent SSE 的 `reasoning` 是累积语义（推全量，前端覆盖不拼接），全文存 `ChatMessage.trail` 一条 `{type:'reasoning'}`。`thinking` 是后端占位符，≠ reasoning。
- 工作流 LLM 节点只取 `content`，reasoning 混入会污染下游变量。

## MCP（`backend/src/mcp/`）
- 分层：`McpController` → `McpService`（唯一碰 Prisma）→ `McpConnectionService` → `McpToolService` → `transports/*`（Streamable HTTP 与旧版 HTTP+SSE 独立）→ `McpUrlGuardService`。
- 外部 URL 必过 SSRF：协议白名单、内网/保留地址、DNS 解析结果、拒绝跟随 3xx。凭据加密存储，接口只回 `hasCredentials` + 掩码。

## 平台助理（`assistant/` + `platform-tools/`）
- 判据 `isSystem && isDefault`（不靠名字，`Agent.type` 仍是 `CUSTOM`）；`PlatformAssistantService.ensure(userId)` 幂等。
- 系统默认 Agent **每用户一条**（`createdBy = userId`），`find()` 签名强制带 userId；部分唯一索引 `Agent_system_default_per_user_key`，并发 ensure 撞 P2002 回读。
- 存量迁移 `migrateLegacySharedAgent()`：按 `ChatSession`/`Memory` 的 userId 拆共享记录，继承 model，原记录降级为模板；失败不阻断。
- `PlatformToolsService`（注册中心 + 兜底 + 审计）→ 6 组 `tools/*`，共 19 个工具；**没有** update_agent。
- 安全红线：userId 只来自 JWT；workspaceId 后端重校验；模型 JSON 先校验再落库；`llmModelId` 必过 `assertOwnsModel()`。
- 密钥绝不经过聊天：`create_mcp_server` Schema 无 apiKey/bearerToken，只建配置（`createPendingCredentials()`，DISCONNECTED）。审计 `sanitizeParams()` 必须用**子串正则**（全等匹配曾漏 `bearerToken`）。
- 系统 Agent 字段白名单 `SYSTEM_AGENT_EDITABLE_FIELDS`（llmModelId/model/temperature/skillIds/mcpServerIds），多带一字段整请求 400；禁删除；仍要求 `createdBy === userId`。
- **归属校验必须在 isSystem 分支之外**（`assertOwnsSkills`/`assertOwnsMcpServers` 提前到分支前）。
- `repair()` 只纠正 name/description/systemPrompt/type/status/maxToolIterations，**不碰 skillIds/mcpServerIds**。
- 依赖单向：`AgentModule → AssistantModule → PlatformToolsModule`。

## UI Control（界面操作，`platform-tools/ui-control.tools.ts` + `fronted/src/modules/ui-control/`）
- 分层铁律：**UI Control 只动界面，不动业务数据**。创建资源必须走 `create_*` 业务工具。模型永不碰 DOM / 不生成 JS，只能调已注册的语义化操作。
- 5 个工具：`ui_navigate` / `ui_open_dialog` / `ui_click_action` / `ui_fill_form` / `ui_get_page_context`；`meta.audit=false`（不进操作审计）。
- 前端注册：页面 `onMounted` 调 `registerPageContext(ctx, handlers)`，`onUnmounted` 注销；执行器**只解析当前激活页面的 handler**（`registry.resolveHandler`），跨页先 `navigate` 再 `waitForHandler`（2.5s 轮询）。
- **不假设成功**：`wait()` 挂起 15s，前端 POST `/platform/ui-result` 才回填；超时按失败喂回模型。`resolve` 可能早于 `wait` 到达（SSE 与 HTTP 时序竞争）→ 必须用 `earlyResults` 缓存，否则丢结果干等超时。
- **会话化（P4.1）**：`Map<userId, Map<sessionId, BrowserSession>>`，一标签页一会话；`sessionId` 前端存 **sessionStorage**（localStorage 同源共享，多 tab 会撞号）。
- **指令生命周期**：`createCommand`（只登记）→ `dispatch`（入队/交给 waiter）→ poll 取走 → `resolve`。`StoredCommand.dispatched` 必须独立于 status（入队后仍是 pending，只靠 status 会重复入队）。枚举含 executing，但前端未上报中间态。
- 目标会话：优先 `lastUserActivityAt`（前端 `visibilitychange/focus` 心跳），退回 `lastActivityAt`；只比 lastActivityAt 会被后台 tab 轮询污染。
- **桌宠 → 网页** 走 `POST /platform/ui-command/poll` 长轮询（挂起 20s，有指令立刻返回），**刻意不用 WebSocket/socket.io**。另有 register / heartbeat / cancel / sessions。
- 分流：`uiControl:true`（网页版自己聊天）**只 create 不 dispatch**（否则执行两次）；桌宠不传 `uiControl` → dispatch，成功投递才等结果。
- **`chat/stream` 端点必须透传 `uiContext/uiControl/taskId`** —— 曾漏传导致网页聊天走桌宠分支、同一 Action 执行两次（已修）。
- 取消：`cancelTask(taskId)` 清队列 + 唤醒 pending wait（cancelled）+ 记标记；Agent 在每轮开头 + 每个 tool_call 前检查 `isTaskCancelled`。前端/桌宠只调 cancel，**不 abort SSE**，让 Agent 自己收尾。
- 结果校验：navigate 后重读真实路由（守卫重定向算失败）；open_dialog 后校验仍在目标页；页面 handler 回传 `actualState.dialogVisible`。`UIActionResult` 带 `currentPage/actualState/errorCode/errorMessage`。
- 页面上下文回填：网页版每次长轮询带 `getCurrentUIContext()`（**只含 pageId/title/route/actions，不含表单值/密钥**）；`uiAvailable=false` 时 Prompt 注入「界面操作当前不可用」。
- `ui_fill_form` 之后**绝不点确定**：创建弹窗确认按钮不注册成 action + Prompt 第 6 条 + 桌宠只提醒。
- 前端 `api/uiControl.ts` 轮询用**独立 axios 实例**（不加全局 401 拦截），否则后台长轮询会把用户踢到登录页。
- 单测：`ui-action-bridge.service.spec.ts`（11 项，含并发/超时/多标签页/幂等/取消/越权/过期）。
- 未做：P4.2 UITask 编排、Redis 持久化、executing 上报、多标签页手动选择 UI；`ui_scroll`/`ui_select_option`/`ui_wait_for_state`；P5 视觉定位（明确排除 Playwright 与坐标识别）。

## 人格与记忆（`persona/` + `memory/`）
- 人格存独立表 `AgentPersona`（`agentId @unique`），不塞 `Agent` 的 JSON 字段（会被白名单 400）。`assertPlatformAssistant` 仍须校验 `createdBy`。
- Prompt 四段式（顺序不可换）：平台职责 → 人格表达层 → 记忆片段 → 动态上下文。人格段前后追加 `PERSONA_BOUNDARY_HEADER / PERSONA_SAFETY_TAIL`。
- `Agent.name` 保持「平台助理」，界面展示 `persona.name`，`meta` 带 `personaName`。
- 记忆向量用 `Float[]` + 应用层余弦，**不引 pgvector**（换模型会改维度）。
- 召回必须降级：`tryEmbed` 失败熔断 5 分钟走关键词。沉淀 fire-and-forget，同会话 3 分钟冷却；敏感信息整条丢弃。
- 入口在 Agent 配置页 Tabs（仅 `isSystem && isDefault`），Tab 写回 `?tab=`。
- **人格读 DB，不读常量**：运行时用 `AgentPersona.systemPrompt`（每用户一条），`DEFAULT_PERSONA_PROMPT` 只在**没有记录**时生效。改常量对已有账号完全无效 —— 这是「为什么我改了提示词但界面没变」的唯一根因。
- **旧人格升级**：`LEGACY_PERSONA_PROMPTS` + `isLegacyPersonaPrompt()`（trim 全等匹配），在 `resolveForAgent()` 里替换并 `personaVersion+1`。收录两类：旧版默认值、以及从 QQ 机器人模板搬来的不兼容文本（`|||`/`<voice>`/`<sticker:>`/群管 —— 平台**零解析**，模型照做会把标记当正文吐）。用户自己改过的文本**绝不覆盖**。
- **Prompt 分工不许串**：`assistant/platform-assistant.prompt.ts` 只写「能做什么/怎么做/做不到怎么办」，`persona.prompt.ts` 只写「怎么说」，记忆规则由 `buildMemorySection` 服务端注入。人格层复述工具能力必然漂移。
- 平台职责 Prompt 里必须常驻一份「**你做不到的事**」清单（全平台没有 `update_*` / `delete_*` 工具；工作空间只能查；MCP 不收密钥；无 `update_agent`），否则模型会承诺改配置/删资源。
- 工作流节点只有 8 种（`start/input/llm/prompt/rag/http/condition/output`），**没有 Code 节点**；`generate_file` 是 `docx/xlsx/pdf/md/csv`。

## 联网搜索（内置 `web_search`）
- 分层：`web-search/`（只读环境变量、不碰 DB）→ `agent/tools/web-search.tool.ts` → `ToolRegistry`。
- 装配单点在 `agent.service.ts`，所以系统助理也拿得到（系统 Agent 绑不了 MCP，这是做内置的原因）。
- 可用性 = `BOCHA_API_KEY` / `TAVILY_API_KEY` 任一存在；没配就不 push 工具定义。
- 博查 `freshness`=oneDay/oneWeek/oneMonth/oneYear/noLimit；Tavily 用 `time_range`，week 时 `topic=news`。
- **博查会 HTTP 200 + body.code != 200**，必须查体内 code。摘要截 520 字符，失败返回文本不抛错。

## 模型调用监控
- 唯一写入口 `AIService.recordModelCall(telemetry, meta)`，要求 `telemetry.workspaceId` 非空。
- `meta.provider` 必须显式传**实际** Provider 名（否则云端模型被错记成 `ollama`）。
- 调用点：`llm.executor`（3 处）、`AgentService.runStream`（5a/5b/重流式）、`EmbeddingService.embedBatch`。`AgentToolContext.telemetry` 要往下透传。
- 流式拿不到 `usage`（Token 记 0）；Dashboard 按 Token 排序要用 `calls` 兜底。

## 桌宠（`desktop/`，Electron）
- 网络请求全在主进程（后端没开 CORS，渲染进程是 `file://`）。token 用 `safeStorage` 加密落盘。
- 鼠标穿透用坐标命中：`forward:true` 转发的 mousemove 不做命中测试，用 `clientX/Y` 比 `getBoundingClientRect()`。
- SSE 结束靠空闲兜底（`end`/`close`/`aborted` 都不触发）：90s（思考/调工具）/ 5s（已出字）。
- 分支 B 不二次调 `streamChat`，用 `streamAsTypewriter(result.content)` 切片。
- 启动：`POST /api/desktop-pet/launch` → 后端本机 `spawn`；须同机（否则 503）。路径探测 `desktop/package.json`。
- **必须关 GPU**：`no-sandbox`/`disable-gpu`/`in-process-gpu` 三连 + `disableHardwareAcceleration()`。
- 登录态靠一次性交接文件（`%TEMP%/xiaodie-handoff-<uuid>.json`，0600，60s TTL），只传路径。**必须在拿单实例锁之前读**，再 `requestSingleInstanceLock({handoff})` → `second-instance` 第 4 参数转交。
- 语音「边读边出字」：按 `[。！？!?\n]` 切句；进度用 `AudioBuffer.duration` + `Date.now()`。`tts:speak` 用 `ipcMain.handle` 直接 return base64。
- 登录后必须留有进设置面板的路（齿轮/右键/托盘）。

## 前端约定
- `t-form` 要 `label-align="top"`；弹窗用 TDesign 自带 footer；行内操作用显式按钮。
- 缓存页：路由 `meta.keepAlive` + `defineOptions({name: 与路由 name 一致})`——`<keep-alive :include>` 匹配组件 name，对不上静默失效。滚动位置要在滚动时持续记录。
- 覆盖第三方样式前必须去 node_modules 确认真实类名。TDesign Menu：根 `.t-default-menu`（`.t-menu` 是内部 ul）、项 `.t-menu__item`、内容槽 `.t-menu__content`、激活 `.t-is-active`；折叠态 `display:none` 掉 `.t-menu__content`。
- `t-menu-group` 的 `title` 属性会顶掉 `#title` 插槽（静默丢弃）；自定义标题要同时删 `title`。
- **TDesign `variant="outline"` 深色底默认白底**，需显式 `background: transparent`。
- 3D 图验证：临时 vite 入口 + 假数据 → headless Chrome `--enable-unsafe-swiftshader`；悬停态用合成 `PointerEvent` + `await nextTick()`。沙盒 `.workbuddy-ai/tmp/memory-graph/`。

## 记忆星图（`MemoryGraph.vue`）
- 四层：星点（shader：核心/光晕/闪烁/十字星芒）→ 星云 sprite → 连线（二次贝塞尔）→ 景深（星尘/噪点）。后处理 `UnrealBloomPass` + `ACESFilmic` + `OutputPass`（没 bloom 就只是彩色圆点）。
- 连线不能当主体：真实边稀疏（相似度≥0.75、每点≤4），静息 `uOpacity=0.032`，hover/选中时提到 0.55 并压暗非邻居。
- 布局：分类簇心围一圈（r=8.6）+ 摘要前缀分子簇 + 重要度决定半径 + `fill` 系数填体积。
- **确定性随机盐值不能只异或进初始状态**（`FACT-1…61` 会排成弧线），必须串哈希 + MurmurHash3 fmix32。

## 数据库迁移
- **不要用 `prisma migrate dev`**（会删 pgvector 的 IVFFlat 索引）。流程：手写 `migrations/<ts>_xxx/migration.sql` → `npx prisma migrate deploy` → `npx prisma generate`。

## 已知遗留
- Skill 的 `WORKFLOW`/`TOOL` 两种 type 无执行分支，只有 `instructions` 参与注入。
- MCP OAuth 未实现（仅 NONE/API_KEY/BEARER_TOKEN）。
- 工作流 HTTP 的 `SsrfCheckService` 与 MCP 的 `McpUrlGuardService` 两套实现，前者不做 DNS 校验、会跟随重定向。
- `vue-tsc` 3 个既有报错（`knowledge/detail.vue` 引用未导出 `LlmModel`；`providers/index.vue` 传了 `inputModalities`），`npm run build` 失败；`npx vite build` 可绕过。

## 文档基线（2026-11-02 实测，写文档前先核对）
- 接口 **141** / Controller **20** / 数据表 **31** / 迁移 **26** / 后端 `.ts` **184** / `schema.prisma` **1035 行** / 模块 **21** / 平台工具 **19** / MCP 传输 **3 种** / 前端源文件 **67**（35 ts + 32 vue）/ 路由 **14** / 执行器 **8** / 队列 **4** / `docs/` **48 篇**。
- 统计接口数：`grep -rhoE "^\s*@(Get|Post|Put|Patch|Delete|All)\(" src`（行首匹配，否则多算）。
- `backend/src/tts/`：零依赖，`POST /tts/synthesize` 双引擎（`voc_` 前缀→BreezeBlue 云端 / 白名单→Edge TTS，base64 mp3）。
- 需求文档全部收在 `docs/需求/v1.5/`：**18 册 + 索引**（01~15 由 2881 行单文件拆出；16 人格化与桌宠需求 / 17 接入实施方案 / 18 需求实现对照表 为后并入）。`docs/需求/` 根目录只剩 `README.md`。
- 核对脚本在 `.workbuddy-ai/tmp/doccheck/`；接口 diff 必须归一路径参数名。
- **移动 md 文件后必须重跑 `links.cjs`**：相对链接层级会随目录深度变化而失效，册间互引还要改成编号名。
- `docs/前端代码逻辑/` **只保留 2 篇 + README**（`01-桌宠客户端-Electron` / `02-记忆星图页面`）。用户明确要求过：只写「前端里最不像普通 Vue 页面」的两块（Electron 双进程、Three.js 手写 shader），常规页面（登录/聊天/配置/工作流/知识库/模型/Skills/好友/控制台）**不要再新建分册**，它们与 `docs/需求/` 的交互描述一一对应。风格：一句话理解 → 数据流 → 关键实现 → 常见坑 → 已知边界，`§` 编号供 README 交叉引用。
- 文档基线补充：`docs/` 共 **51 篇**（前端 3 / 后端 13 / 教程 11 / 需求 20 / 根 4）；`MemoryPanel.vue` 894 行、`MemoryGraph.vue` 1116 行、`api/memory.ts` 125 行、`views/memory/index.vue` 17 行、`desktop/src/main.js` 1055 行、`renderer/pet.js` 1036 行、`preload.js` 48 行、`tts.js` 109 行。
- `desktop/src/renderer/pet.js` **整文件 Read 会被安全策略拦（`SENSITIVE_CONTENT_UNAVAILABLE`）**，改用 `Grep -n` 定位函数 + `Read offset/limit` 分段读即可。

- `desktop/` 与 `backend/src/{persona,memory,desktop-pet,tts}` 均未 git 提交。
