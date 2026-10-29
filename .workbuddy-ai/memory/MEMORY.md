# 项目长期记忆 —— AI WorkFlow Studio

## 分层原则
- MCP 模块只管标准 MCP Server 的连接 / 工具发现 / 调用；普通 HTTP/REST 交给工作流 HTTP 节点。
- 新增外部能力优先「独立模块 + 传输抽象 + 分层服务」，通信逻辑不进 Controller。

## Provider 层（`backend/src/ai/`）
- **只有 2 个实现类**：`OllamaProvider` / `OpenAICompatibleProvider`，承载 4 种 `LlmProviderType`，不建子类（`DeepSeekProvider` 已删——零方法覆盖）。
- 工厂 `createProvider` 是纯函数（非 DI，要按用户 DB 配置运行时构造）。`openai` / `deepseek` **合并成一个 case**（`baseUrl || DEFAULT_BASE_URL[provider]` + `provider` 作 name）；`openai-compatible` 不能并（无默认 baseUrl，缺了抛错）。
- 两个不能动：`DEFAULT_BASE_URL` 的 key（`resolveBaseUrl()` 靠它持久化默认地址，两处逻辑必须同步改）；第三参数 `name` 必须与类型同名（写进 `ModelCallLog.provider`，仪表盘按它分组）。
- 枚举值 `deepseek` 不能删——删了要数据迁移、断前端下拉和 `resolveBaseUrl`。
- **推理与正文是两条流**：`streamChat` 返回 `ChatStreamChunk = {type:'content'|'reasoning', text}`，只要正文套 `contentOnly()`。非流式 `ChatResult.reasoning?`（无 CoT 时字段**不存在**而非空串）。字段名三套：`reasoning_content`（DeepSeek/SiliconFlow）、`reasoning`（OpenRouter）、`message.thinking`（Ollama）。
- Agent SSE 的 `reasoning` 是**累积语义**（每次推全量，前端覆盖不拼接），全文存 `ChatMessage.trail` 的一条 `{type:'reasoning', content}`（无新字段、无迁移）。
- **不要用 `ChatOptions.onReasoning` 回调**：async generator 里回调不能 yield，推理阶段前端空转。
- `thinking` ≠ `reasoning`：前者是后端自造「思考中...」占位（前端过滤），后者是真实思维链（独立折叠面板）。
- 工作流 LLM 节点只取 `content` 分片——reasoning 混进节点输出会污染下游变量。

## MCP 模块（`backend/src/mcp/`）
- 分层：`McpController` → `McpService`（配置+凭据+编排，唯一碰 Prisma）→ `McpConnectionService`（会话/缓存）→ `McpToolService` → `transports/*`（Streamable HTTP 与旧版 HTTP+SSE 各自独立）→ `McpUrlGuardService`。
- 工具按 Agent / LLM 节点配置筛选，不无差别塞给每次调用。凭据加密存储，接口只返回 `hasCredentials` + 掩码。
- 外部 URL 必须过 SSRF 校验：协议白名单、内网/保留地址、**DNS 解析结果**、拒绝跟随 3xx。

## 平台助理（`assistant/` + `platform-tools/`）
- 判据 **`isSystem && isDefault`**（不靠名字，`Agent.type` 仍是 `CUSTOM`）；初始化/迁移走 `PlatformAssistantService.ensure()`（幂等）。
- 分层：`PlatformToolsService`（注册中心 + 异常兜底 + 审计）→ 6 组 `tools/*` → 既有业务 Service。共 19 个工具；**没有** update_agent，已有 Agent 的 MCP 绑定改不了。
- 安全红线：`userId` 只来自 JWT（Schema 里没有 userId）；`workspaceId` 后端重校验；模型生成的 JSON 先校验再落库（`workflow-definition.util.ts`）。
- **密钥绝不经过聊天**：`create_mcp_server` Schema 里没有 apiKey/bearerToken；需认证的 Server 只建配置（`createPendingCredentials()`，status=DISCONNECTED），凭据只能用户在 /mcp 页填。审计 `sanitizeParams()` 必须用**子串正则**（早期 key 全等匹配，`bearerToken` 漏网，明文进审计表）。
- 默认不绑固定模型，走 `resolveUserDefaultChatModel(userId)`；`llmModelId` 有值则优先。
- **系统 Agent 按字段白名单收窄**：只有 `llmModelId / model / temperature`（`SYSTEM_AGENT_EDITABLE_FIELDS`），多带一个字段整个请求 400；删除禁止。前端保存必须只发模型字段。
- 依赖单向：`AgentModule → AssistantModule → PlatformToolsModule`。`create_agent` 用 Prisma 是为避免反向依赖，默认值需与 `AgentService.create` 手工同步。
- 审计表 `PlatformOperationLog` 与 `ChatMessage.trail` 解耦，写入失败不影响主流程。

## 人格与记忆（`persona/` + `memory/`）
- **人格存独立表 `AgentPersona`**，不塞 `Agent` 的 JSON 字段（会被白名单 400 拒）。
- Prompt 四段式（顺序不可换）：平台职责 → 人格表达层 → 记忆片段 → 动态上下文（`composeSystemPromptWithExtras`）。人格段前后服务端追加 `PERSONA_BOUNDARY_HEADER / PERSONA_SAFETY_TAIL`。
- `Agent.name` 保持「平台助理」作系统标识，界面展示 `persona.name`（`displayName`），`meta` 事件带 `personaName`。
- **记忆向量用 `Float[]` + 应用层余弦，不引 pgvector**：换 Embedding 模型会改维度，固定维度列要重建。
- 召回在对话关键路径，必须降级：`tryEmbed` 失败一次熔断 5 分钟走关键词。沉淀是 fire-and-forget，同会话 3 分钟冷却；JSON 逐字段校验；命中敏感信息整条丢弃。
- 入口收在 Agent 配置页 Tabs（仅 `isSystem && isDefault`），不做侧边栏；Tab 写回 `?tab=`。组件：`PersonaPanel.vue`、`components/memory/MemoryPanel.vue`。

## 模型调用监控
- 唯一写入口 `AIService.recordModelCall(telemetry, meta)`，要求 `telemetry.workspaceId` 非空。
- `meta.provider` 必须调用方显式传**实际** Provider 名——`AIService` 注入的是全局 Ollama，Agent / LLM 节点用动态构造的 Provider，不传会把云端模型错记成 `ollama`。
- 调用点（新增必须同步补）：`llm.executor`（chat/streamChat/chatWithTools）、`AgentService.runStream`（5a 流式 / 5b chatWithTools / 5b 重流式）、`EmbeddingService.embedBatch`。`AgentToolContext.telemetry` 要往下透传（`workflow.tool.ts`、`knowledge.tool.ts`）。
- 归属回退链 `resolveTelemetryWorkspaceId()`：校验空间 → 平台助理首个可访问空间 → `agent.workspaceId` → 前端传入 → 用户首个可见空间。
- 流式拿不到 `usage`（Token 记 0，次数正常）；Dashboard 按 Token 排序时要用 `calls` 兜底。

## 桌宠（`desktop/`，Electron）
- **网络请求全在主进程**：后端没开 `enableCors()`，渲染进程是 `file://` 源。token 用 `safeStorage`（DPAPI）加密落盘。
- **鼠标穿透用坐标命中**：`forward: true` 转发的 mousemove 不做命中测试，`e.target` 是 `<html>`；用 `clientX/Y` 比 `getBoundingClientRect()`。
- **SSE 结束靠空闲兜底**：`end`/`close`/`aborted` 都不触发。分档 90s（思考/调工具）/ 5s（已出字），给小了会把首 token 延迟误判成结束。
- 分支 B 不二次调 `streamChat`，改 `streamAsTypewriter(result.content)` 切片（2.8s vs 5.9s），避免气泡突变和长度回退。
- 启动：网页 Header 小圆脸 → `POST /api/desktop-pet/launch` → 后端本机 `spawn`；后端必须与用户同机（否则 503）。路径靠**探测** `desktop/package.json`（cwd 与 `__dirname` 各往上 6 层）。
- **必须关 GPU**：`no-sandbox`/`disable-gpu`/**`in-process-gpu`** 三连 + `disableHardwareAcceleration()`。少了 `in-process-gpu` 会 GPU 进程连崩后退出（`npm start` 一闪而过）。
- **登录态靠一次性交接文件**：后端写 `%TEMP%/xiaodie-handoff-<uuid>.json`（0600，60s TTL），只把**路径**放 `env.XIAODIE_HANDOFF`；token 绝不走命令行/env。
- **交接文件必须在拿单实例锁之前读**：第二进程锁失败即退出、env 传不到第一个实例；要先读，再 `requestSingleInstanceLock({ handoff })` → `second-instance` 第 4 个参数转交。否则含完整 token 的文件烂在临时目录且换账号失效。
- **语音「边读边出字」**：按 `[。！？!?\n]` 切句，逐句「合成→播放→写到哪句显示哪句」；进度用 `AudioBuffer.duration` + `Date.now()` 算（不要每 tick 累加，setInterval 会漂移）。`tts:speak` 用 `ipcMain.handle` 直接 return base64，不要事件推送（拿不到「这句播完」时序）。
- **登录后必须留有进设置面板的路**：`onPetClick()` 登录态只弹输入框，面板入口要单独给（齿轮/右键/托盘）。语音开关踩过这坑。
- `reasoning` 事件只需保持 `thinking` 动画（推理期无 `message`，不处理会像卡死）。

## 前端约定
- `t-form` 要 `label-align="top"`；弹窗用 TDesign 自带 footer；行内操作用显式按钮而非 `t-dropdown` + `@click.stop`。
- **缓存页**：路由 `meta.keepAlive: true` + 组件 `defineOptions({ name: '与路由 name 一致' })`——`<keep-alive :include>` 匹配**组件 name**，对不上**静默失效**。恢复滚动位置要在滚动时持续记录（`onDeactivated` 里 `scrollTop` 已归零）。
- 接口返回要显式剥离敏感字段，不靠前端过滤。
- **覆盖第三方样式（`:deep()`）前必须去 node_modules 确认真实类名**：写错不报错、只静默失效，默认+自定义叠加 → 表现成「样式错乱」。查法 `grep -o '\.t-menu[a-z0-9_-]*' node_modules/<pkg>/es/<comp>/style/index.css | sort -u`。
  TDesign Menu：根节点 `.t-default-menu`（不是 `.t-menu`，那是内部 ul）、项 `.t-menu__item`、内容槽 `.t-menu__content`、激活 `.t-is-active`、折叠 `.t-default-menu.t-is-collapsed`；**折叠态会 `display:none` 掉 `.t-menu__content`**。
- **`t-menu-group` 的 `title` 属性会顶掉 `#title` 插槽**（`renderTNodeJSX` 没传 `slotFirst`，静默丢弃、无警告）。自定义标题要同时删 `title`；只加按钮就放默认插槽。
- 纯样式改动可复用 `.workbuddy-ai/tmp/sidebar-check/render-check.cjs`（真实 CSS + scoped CSS + DOM 快照 → Chrome `--headless=new`）。截图必须写在工作区内（系统 temp 会被沙箱拒）。

## 数据库迁移
- **不要用 `prisma migrate dev`**（会把 pgvector 的 IVFFlat 索引当多余对象删）。流程：手写 `migrations/<ts>_xxx/migration.sql` → `npx prisma migrate deploy` → `npx prisma generate`。

## 已知遗留
- Agent 侧 Skill（`Agent.skillIds`）未接入运行时（只有工作流 LLM 节点注入）。
- MCP OAuth 未实现（只支持 NONE / API_KEY / BEARER_TOKEN）。
- 工作流 HTTP 的 `SsrfCheckService` 与 MCP 的 `McpUrlGuardService` 是两套实现，前者不做 DNS 校验、会跟随重定向。
- `vue-tsc` 有 3 个既有报错（`knowledge/detail.vue` 引用未导出的 `LlmModel`；`providers/index.vue` 传了 `UpdateLlmModelRequest` 里没有的 `inputModalities`），`npm run build` 会失败；`npx vite build` 可绕过。已告知用户，未修。

## 文档基线（2026-10-29 实测，写文档前先核对）
- 接口 **141** / Controller **20** / 数据表 **31** / 迁移 **25** / 后端 `.ts` **181** / `schema.prisma` **1029 行** / 模块 **21** / 平台工具 **19** / MCP 传输 **3 种** / 前端源文件 **67**（35 ts + 32 vue）/ 路由 **14** / 执行器 **8** / 队列 **4** / `docs/` **47 篇**。
- 统计接口数：`grep -rhoE "^\s*@(Get|Post|Put|Patch|Delete|All)\(" src`（**行首**匹配，否则命中注释里的 `@Get(':id')` 多算）。
- `backend/src/tts/`：零依赖，`POST /tts/synthesize`（`msedge-tts` v2，返回 base64 mp3），`voice` 限 `VOICE_IDS` 白名单。
- 需求文档已按模块拆分：`docs/需求/v1.5/` 15 册 + README（原 2881 行单文件已删，git 可回溯），索引 `docs/需求/README.md`。
- 两份报告只记**仍未闭环**项：审查报告 = G2（流式 LLM 节点忽略 tools）/ G3（RAG 不过滤 `Document.status`）/ Agent 侧 Skill；同步报告 = L1(G2+G3) / L2(Skill) / L3(`.page-toolbar` 死规则 + 未引用 `global.css`)。已解决的一律删掉。
- 核对脚本在 `.workbuddy-ai/tmp/doccheck/`（routes / links / lines）；接口 diff 必须归一路径参数名。
- `desktop/` 与 `backend/src/{persona,memory,desktop-pet,tts}` **均未 git 提交**。
