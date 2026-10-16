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
- 上下文注入只给元信息（我是谁 / 当前空间 / 可访问空间 / 能力清单），业务数据一律按需工具查询。
- 平台助理默认不绑定固定模型，运行时走 `LlmConfigService.resolveUserDefaultChatModel(userId)`；
  但 `llmModelId` 一旦有值就优先按它解析（用户可在 Agent 配置页指定），此时对该实例下所有用户生效。
- **系统 Agent 的修改权限按字段白名单收窄**：只有 `llmModelId / model / temperature` 可改
  （`SYSTEM_AGENT_EDITABLE_FIELDS`，带其他字段即 400），`createdBy` 为 null 故跳过归属校验；删除一律禁止。
  前端保存系统 Agent 时必须「只发模型字段」——多带一个字段整个请求都会被拒。
- 审计表 `PlatformOperationLog` 与 `ChatMessage.trail` 解耦；写入失败不得影响主流程。
- 模块依赖方向：`AgentModule → AssistantModule → PlatformToolsModule`（单向）。
  `create_agent` 工具直接用 Prisma 就是为了避免反向依赖，其默认值需与 `AgentService.create` 手工同步。

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
