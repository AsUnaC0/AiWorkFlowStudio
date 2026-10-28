# 项目长期记忆 —— AI WorkFlow Studio

## 架构约定

### 分层原则
- **MCP 模块只负责连接标准 MCP Server、发现工具、调用工具**；普通 HTTP/REST API 一律交给工作流 HTTP 节点，不在 MCP 里重复实现。
- 新增外部能力时优先「独立模块 + 传输抽象 + 分层服务」，不要把所有通信逻辑写进 Controller。

### MCP 模块（`backend/src/mcp/`）
- 分层：`McpController`（入口）→ `McpService`（配置 + 凭据 + 编排，唯一碰 Prisma）→
  `McpConnectionService`（会话生命周期/缓存）→ `McpToolService`（工具发现/schema/调用）→
  `transports/*`（Streamable HTTP 与旧版 HTTP+SSE，各自独立实现）→ `McpUrlGuardService`（安全校验）。
- 传输方式的区分不能只靠下拉框：Streamable HTTP 与旧版 SSE 的连接流程、响应解析、会话管理完全不同。
- 工具按 Agent / LLM 节点配置筛选，**不做「所有工具无差别塞给每次模型调用」**。
- 凭据必须加密存储（复用 `EncryptionService`），接口只返回 `hasCredentials` + 掩码，绝不返回明文。
- 用户可配置的外部 URL 必须过 SSRF 校验：协议白名单、内网/保留地址、**DNS 解析结果**、拒绝跟随 3xx。

### 平台助理（`backend/src/assistant/` + `backend/src/platform-tools/`）
- 默认 Chat Agent = 平台助理，识别判据是 **`isSystem && isDefault`**（不靠名字，`Agent.type` 仍是 `CUSTOM`）。
  初始化 / 历史迁移统一走 `PlatformAssistantService.ensure()`（幂等，旧 `meibus` 记录原地升级保留 id）。
- 分层：`PlatformToolsService`（注册中心：buildDefinitions / execute + 异常兜底 / 审计 / operation 载荷）
  → 6 组 `tools/*` → **既有业务 Service**（WorkflowsService / KnowledgeService / DocumentService /
  StorageService / Prisma）。工具由后端注册，用户无法通过聊天消息临时定义。
- 安全红线：`userId` 只来自已验证 JWT（工具入参 Schema 里没有 userId）；`workspaceId` 后端重新校验成员关系；
  **模型生成的 JSON 一律先校验再落库**（`workflow-definition.util.ts`，节点类型白名单来自 NodeExecutorRegistry）。
- **密钥绝不经过聊天**：`create_mcp_server` 的 Schema 里没有 apiKey / bearerToken，模型硬塞就返回 FAILED；
  需要认证的 Server 只建配置（`McpService.createPendingCredentials()`，credentials 留空、status=DISCONNECTED），
  凭据只能由用户在 /mcp 页面填。审计 `sanitizeParams()` 必须用**子串正则**匹配敏感 key ——
  早期用 key 全等匹配，`bearerToken` 会漏，密钥明文进审计表。
- 目前 19 个平台工具（skill-mcp 组 5 个：list_skills / list_mcp_servers / get_platform_overview /
  create_mcp_server / create_skill）。仍**没有** update_agent，所以已有 Agent 的 MCP 绑定改不了。
- 上下文注入只给元信息（我是谁 / 当前空间 / 可访问空间 / 能力清单），业务数据一律按需工具查询。
- 平台助理默认不绑定固定模型，运行时走 `LlmConfigService.resolveUserDefaultChatModel(userId)`；
  但 `llmModelId` 一旦有值就优先按它解析（用户可在 Agent 配置页指定），此时对该实例下所有用户生效。
- **系统 Agent 的修改权限按字段白名单收窄**：只有 `llmModelId / model / temperature` 可改
  （`SYSTEM_AGENT_EDITABLE_FIELDS`，带其他字段即 400），`createdBy` 为 null 故跳过归属校验；删除一律禁止。
  前端保存系统 Agent 时必须「只发模型字段」——多带一个字段整个请求都会被拒。
- 审计表 `PlatformOperationLog` 与 `ChatMessage.trail` 解耦；写入失败不得影响主流程。
- 模块依赖方向：`AgentModule → AssistantModule → PlatformToolsModule`（单向）。
  `create_agent` 工具直接用 Prisma 就是为了避免反向依赖，其默认值需与 `AgentService.create` 手工同步。

### 人格与记忆（`backend/src/persona/` + `backend/src/memory/`）
- **人格存独立表 `AgentPersona`，不塞进 `Agent` 的 JSON 字段**：`AgentService.update` 对系统 Agent 只放开
  `llmModelId / model / temperature`（`SYSTEM_AGENT_EDITABLE_FIELDS`），塞 Agent 上会被 400 拒掉。
- Prompt 四段式装配（顺序不可调换）：平台职责 → 人格表达层 → 记忆片段 → 动态上下文
  （`composeSystemPromptWithExtras`）。人格段前后由服务端追加 `PERSONA_BOUNDARY_HEADER / PERSONA_SAFETY_TAIL`，
  保证「不承认自己是程序」只作用于表达层，不削弱身份判定与审计。
- `Agent.name` 保持「平台助理」作为系统标识；界面展示 `persona.name`（`displayName`），
  `AgentService` 的 `meta` 事件带 `personaName`。
- **记忆向量用 `Float[]` + 应用层余弦，不引 pgvector**：用户换 Embedding 模型会改维度，
  固定维度列要重建；单用户记忆量级小，应用层算足够。知识库那套「每版本一张向量表」的复杂度不值得复制。
- 记忆召回在对话关键路径上，必须能降级：`tryEmbed` 失败一次就熔断 5 分钟走关键词召回，
  否则 Ollama 没起时每轮对话都要等 embedding 超时。
- 记忆沉淀是 fire-and-forget（`void memoryWriter.maybeCapture`），同会话 3 分钟冷却；
  模型输出的 JSON 必须逐字段校验后才落库；命中敏感信息整条丢弃。
- `MemoryModule → KnowledgeModule`（只为拿 `EmbeddingService`）是单向的，`AgentModule` 可安全 import 两者。
- **人格 / 记忆的入口收在 Agent 配置页**（`views/agents/detail.vue` 的 Tabs，仅 `isSystem && isDefault` 显示），
  不做侧边栏菜单 —— 它们是平台助理这个 Agent 的属性，不是独立功能模块。Tab 状态写回 `?tab=` 便于深链。
  面板组件：`views/agents/components/PersonaPanel.vue`、`components/memory/MemoryPanel.vue`（embedded / 全屏共用）。

### 模型调用监控（ModelCallLog / Dashboard）
- 所有模型调用记录的唯一写入口是 `AIService.recordModelCall(telemetry, meta)`；
  **要求 `telemetry.workspaceId` 非空**（表字段 NOT NULL），无归属上下文的调用一律不记录。
- `meta.provider` 必须由调用方显式传入**实际** Provider 名。不要依赖默认值 ——
  `AIService` 注入的是全局 Ollama，而 Agent / LLM 节点用的是 `LlmConfigService.resolveModelRuntime()`
  动态构造的 Provider，不传就会把云端模型错误归属成 `ollama`。
- 调用点（新增 Provider 调用时必须同步补记录，否则仪表盘会漏）：
  工作流 `llm.executor`（chat / streamChat / chatWithTools 三路）、
  `AgentService.runStream`（5a 纯流式、5b chatWithTools、5b 重流式）、
  `EmbeddingService.embedBatch`（EMBEDDING）。
- `AgentToolContext.telemetry` 会把归属继续往下传：Agent 通过工具跑工作流（`workflow.tool.ts` → `engine.run`
  的 `workspaceId`）、知识库检索（`knowledge.tool.ts` → `search` 的 `telemetry`）都依赖它，
  新增「会间接发起模型调用」的工具时别忘了透传。
- `AgentService` 用 `resolveTelemetryWorkspaceId()` 解析归属空间，回退链：
  平台助理校验空间 → 平台助理首个可访问空间 → `agent.workspaceId` → 前端传入 → 用户首个可见空间。
- 流式调用拿不到 `usage`，Token 记为 0 但调用次数正常；Dashboard 的模型图按 Token 排序时
  要用 `calls` 兜底，否则「有调用没 Token」的模型会被挤到看不见。

### 桌宠客户端（`desktop/`，Electron）
- 独立 Electron 工程，MVP 子集：透明置顶窗口 + 托盘 + 拖拽 + 内联 SVG 形象 + 文字气泡 + SSE 对话。
  不含 Live2D / TTS / 截屏感知。
- **所有网络请求必须在主进程**：后端 `main.ts` 没开 `enableCors()`，渲染进程是 `file://` 源（`Origin: null`）。
  附带好处是 token 只存在主进程，用 `safeStorage`（Windows DPAPI）加密落盘。
- **鼠标穿透必须用坐标命中**：`setIgnoreMouseEvents(true, { forward: true })` 转发的 mousemove 不做命中测试，
  `e.target` 是 `<html>`，`closest()` 永远判不到；要用 `clientX/Y` 比 `getBoundingClientRect()`。
- **SSE 结束靠空闲兜底**：Electron 主进程读 `text/event-stream` 时 `end` / `close` / `aborted` 都不触发
  （后端已 `response.end()`）。分档 90s（思考/调工具）/ 5s（已出字），阈值给小了会把首 token 延迟误判成结束。
- 后端 `agent.service.ts` 分支 B 不再二次调 `streamChat`，改 `streamAsTypewriter(result.content)` 切片推送：
  少一次模型调用（2.8s vs 5.9s），也避免两次生成不一致导致前端气泡**突变**、累积长度**回退**。
- **启动方式**：网页 Header 右上角小圆脸 → `POST /api/desktop-pet/launch` → 后端在本机 `spawn` Electron。
  浏览器不允许网页起本地程序，这是唯一能通的路；后端必须与用户同机，否则返回 503。
  `DesktopPetService` 靠**探测** `desktop/package.json`（cwd 与 `__dirname` 各往上 6 层）而不是写死相对路径。
- **本机必须关 GPU**：`app.commandLine.appendSwitch` 三连 `no-sandbox` / `disable-gpu` / **`in-process-gpu`**
  + `app.disableHardwareAcceleration()`。少了 `in-process-gpu` 会 `GPU process exited unexpectedly` 连崩后直接退出，
  表现是 `npm start` 一闪而过。
- **登录态靠「一次性交接文件」传递，点开即登录**：后端写 `%TEMP%/xiaodie-handoff-<uuid>.json`
  （token/baseUrl/userId/email/expiresAt，0600，60s TTL），只把**路径**放进 `env.XIAODIE_HANDOFF`；
  token 绝不走命令行或 env（进程命令行同机任何用户可见）。桌宠读完立即删除。
- **交接文件必须在拿单实例锁之前读**：桌宠已开着时第二个进程 `requestSingleInstanceLock()` 失败就退出，
  **它的 env 传不到第一个实例**。要先读文件，再用 `requestSingleInstanceLock({ handoff })` →
  `second-instance` 第 4 个参数交给第一个实例。否则文件烂在临时目录 60 秒（含完整 token）且换账号失效。
- **语音必须「边读边出字」**：`message` 事件按 `[。！？!?\n]` 切句 → 逐句「合成 → 播放 → 写到哪句显示哪句」；
  打字机进度用 `AudioBuffer.duration` + `Date.now()` 算（**不要**每次 tick 累加固定字数，setInterval 会漂移）。
  `tts:speak` 走 `ipcMain.handle` **直接 return base64 音频**，不要用事件推送 —— 事件拿不到「这句播完」的时序。
- **登录后必须留有进设置面板的路**：`onPetClick()` 在登录态只会弹输入框，所以面板入口单独给
  （右上角齿轮 / 右键小蝶 / 托盘「设置…」）。否则面板里的开关用户永远看不见 —— 语音开关就踩过这个坑。
- **`t-menu-group` 的 `title` 属性会顶掉 `#title` 插槽**：`renderTNodeJSX('title', {silent:false})`
  没传 `slotFirst`，`isPropExplicitlySet` 为真时直接返回 prop 字符串，插槽被**静默丢弃**（无警告）。
  要自定义标题必须同时删掉 `title` 属性；只想加操作按钮，就把按钮放进**默认插槽**（和菜单项同级）。

### 数据库迁移
- **不要用 `prisma migrate dev`**（会把 pgvector 的 IVFFlat 索引当多余对象删掉）。
  流程：手写 `prisma/migrations/<timestamp>_xxx/migration.sql` → `npx prisma migrate deploy` → `npx prisma generate`。

### 编码约定
- 后端所有用户可配置的外部 URL 都要做 SSRF 校验；响应要有超时与大小上限。
- 前端表单用 `t-form` 时需 `label-align="top"`；弹窗用 TDesign 自带 footer；行内操作用显式按钮而非 `t-dropdown` + `@click.stop`。
- **需要缓存的页面**（如聊天页）：路由加 `meta.keepAlive: true`，且页面组件必须 `defineOptions({ name: '与路由 name 一致' })` —— `<keep-alive :include>` 匹配的是**组件 name 而非路由 name**，对不上会**静默失效**。`MainLayout` 的 `cachedViews` 自动从路由 meta 收集，新增缓存页无需改布局文件。缓存页若要恢复滚动位置，须在滚动时持续记录（`onDeactivated` 里读 `scrollTop` 已归零）。
- 接口返回给前端的对象要显式剥离敏感字段（不要靠前端过滤）。
- **覆盖第三方组件样式（`:deep()`）前必须先去 node_modules 确认真实类名**：类名写错不会报错，只会静默失效，然后默认样式和自定义样式叠加 → 表现成「样式错乱」，极难排查。
  查法：`grep -o '\.t-menu[a-z0-9_-]*' node_modules/<pkg>/es/<comp>/style/index.css | sort -u`，或直接读 `es/<comp>/<comp>.mjs` 里的 `classPrefix` 拼接。
  TDesign Menu 的坑（chat 侧边栏踩过）：根节点是 `.t-default-menu`（**不是** `.t-menu`，`.t-menu` 是内部 `ul`）、菜单项 `.t-menu__item`（不是 `.t-menu-item`）、内容槽 `.t-menu__content`、激活态 `.t-is-active`、折叠态 `.t-default-menu.t-is-collapsed`。
  且**折叠态会 `display:none` 掉 `.t-menu__item > .t-menu__content`**，自定义内容放进内容槽时会被一起隐藏。
- 只做前端样式改动时，可复用 `.workbuddy-ai/tmp/sidebar-check/render-check.cjs` 的做法做无头渲染校验：真实组件 CSS + 组件 scoped CSS + 手写 DOM 快照 → 静态 HTML → 本机 Chrome `--headless=new --screenshot` / `--dump-dom` 读计算样式。截图输出必须写在工作区内（写系统 temp 会被沙箱拒绝）。

### 已知遗留
- Agent 侧 Skill（`Agent.skillIds`）仍未接入运行时（只有工作流 LLM 节点会注入 Skill instructions）。
- MCP OAuth 未实现，目前只支持 NONE / API_KEY / BEARER_TOKEN。
- 工作流 HTTP 节点的 `SsrfCheckService` 与 MCP 的 `McpUrlGuardService` 是两套独立实现，前者不做 DNS 校验、会跟随重定向。


### 文档同步基线（2026-10-28 实测，写文档前先核对）
- 接口 **141** / Controller **20** / 数据表 **31** / 迁移 **25** / 后端 `.ts` **181** / `schema.prisma` **1029 行** / 注册模块 **21** / 平台工具 **19** / MCP 传输 **3 种**（Streamable HTTP / SSE / STDIO）。
- 统计接口数的正确姿势：`grep -rhoE "^\s*@(Get|Post|Put|Patch|Delete|All)\(" src`（**行首**匹配，否则会命中注释里的 `@Get(':id')` 多算 1 个）。
- `backend/src/tts/`：**零依赖**模块，`POST /tts/synthesize`（`msedge-tts` v2 令牌，返回 base64 mp3），是桌宠「边读边出字」的后端兜底；`voice` 限 `VOICE_IDS` 白名单（`persona/persona.prompt.ts`）。文档见 08 第九节 / 教程 00 §3.16 / 教程 08 §6.10。
- `desktop/`（Electron 桌宠）与 `backend/src/{persona,memory,desktop-pet,tts}` 目前**均未 git 提交**（untracked），文档已按工作区实况写好。
