# AI WorkFlow Studio — 后端代码逻辑文档

> 面向**小白开发者**的代码讲解文档，按业务模块拆分，覆盖每一条后端业务逻辑的入参、出参、中间处理和调用链路。

---

## 文档目录

| 序号 | 文件 | 覆盖范围 | 读完你应该能回答 |
|---|---|---|---|
| 01 | [项目架构与入口](./01-项目架构与入口.md) | main.ts / app.module.ts / PrismaService / StorageService / EncryptionService | NestJS 怎么启动？全局依赖怎么注入？数据库表有哪些？ |
| 02 | [Auth 认证模块](./02-Auth认证模块.md) | AuthService / JwtStrategy / JwtAuthGuard | 注册登录完整流程？JWT 怎么生成和校验？为什么 validate 里还要查数据库？ |
| 03 | [AI Provider 大模型接入层](./03-AI%20Provider大模型接入层.md) | AiProvider 接口 / OllamaProvider / OpenAICompatibleProvider / DeepSeekProvider / ProviderFactory | AI_PROVIDER Symbol 怎么变成真实大模型？3 种 Provider 怎么发 HTTP 请求？流式和非流式怎么解析？ |
| 04 | [Agent 智能体模块](./04-Agent智能体模块.md) | AgentService / runStream ReAct 循环 / **平台助理分支** / 工具三级路由（平台 → MCP → ToolRegistry）/ ChatSession | ReAct 循环每轮发生什么？工具怎么注册和路由？平台助理怎么接管默认 Agent？ChatSession 怎么持久化？ |
| 05 | [工作流引擎](./05-工作流引擎.md) | WorkflowEngine / NodeExecutorRegistry / 8 种 Executor / VariableService / WorkflowsService / BullMQ | 画布定义怎么变成可执行的？8 种节点各自做什么？变量模板 {{xxx}} 怎么解析？Condition 怎么选分支？ |
| 06 | [知识库与 RAG](./06-知识库与RAG.md) | KnowledgeService / DocumentProcessor / DocumentParser / EmbeddingService / VectorStoreService / KnowledgeRetrievalService | 文档上传后怎么变成向量？pgvector 检索有几种模式？RRF 融合怎么工作？ |
| 07 | [LLM 模型配置管理](./07-LLM模型配置管理.md) | LlmConfigService / 加密存储 / resolveModelRuntime() | API Key 怎么保护？运行时怎么动态绑定 Provider？Agent 怎么从本地 Ollama 切到云端 DeepSeek？ |
| 08 | [MCP-Skill-Storage-其他模块](./08-MCP-Skill-Storage-其他模块.md) | McpService / SkillService / StorageService / Workspace / Dashboard / Friendship | MCP Server 怎么被 LLM 调用？Skill 是什么？七牛云怎么切换？Workspace 权限模型是怎样的？ |
| 09 | [文件生成模块](./09-文件生成模块.md) | FilesService / FileGeneratorService / FileStorageService / FilePreviewService / 5 个生成器 / word.repair | AI 怎么真的产出可下载的 Word/Excel/PDF？预览数据怎么来的？为什么 Word 打不开生成的 docx？ |
| 10 | [聊天文件上传模块](./10-聊天文件上传模块.md) | ChatFilesService / FileParserService / FileContextService / 6 个解析器 / BullMQ 解析 Worker | 用户上传的 PDF/Word/Excel/图片怎么变成 AI 上下文？附件为什么不上知识库？Redis 挂了还能用吗？ |
| 11 | [平台助理](./11-平台助理.md) | PlatformAssistantService / PlatformToolsService / 17 个平台工具 / PlatformOperationLog / 聊天页操作卡片 | 默认聊天 Agent 怎么变成「能操作平台」的？模型生成的 JSON 怎么防止直接落库？userId 为什么不可伪造？审计表为什么和 trail 分开？ |

---

## 代码路径约定

文中所有 `backend/src/xxx.ts` 路径均相对于项目根目录 `c:\Users\meibus\Desktop\AI WorkFlow Studio`。

## 推荐阅读顺序

想快速上手 → **01 → 03 → 04 → 05**（架构 → 大模型层 → Agent 调用 → 工作流引擎）

想做 RAG → **06 → 03 → 04**（知识库 → Provider → Agent Knowledge Tool）

想接云端模型 → **07 → 03**（配置管理 → Provider 实现）

想加新节点类型 → **05 → 03**（Engine + Executor 模式 → 需要调 LLM 时看 Provider）

想加新导出格式 / 排查"Word 打不开" → **09 → 08**（文件生成模块 → StorageService）

想给聊天页加"上传文件对话" → **10 → 04 → 03**（聊天附件 → Agent runStream → Provider 视觉输入）

想给平台助理加一个新工具 → **11 → 04 → 05**（工具契约 → runStream 工具路由 → 工作流校验规则）

---

## 本文档的准确性说明

本套文档已对照 `backend/src/**` 与 `prisma/schema.prisma` 逐方法核验过，详见 **[后端代码逻辑审查报告](./后端代码逻辑审查报告.md)**（含 8 处硬性错误的修订记录）。

### 本次更新的修订记录（对照当前代码重新核验）

| # | 位置 | 修订内容 |
|---|---|---|
| 1 | 新增 09 | `backend/src/files/**` 此前**完全没有文档**，补齐文件生成模块的完整链路（含 docx 兼容性这一最大坑） |
| 2 | 04 | `Agent` 模型缺 `enableFileGeneration`；`ToolRegistry` 缺 `generate_file` 路由（原来只写了 workflow / knowledge 两个工具） |
| 3 | 08 - Dashboard | 接口数 7 → **10**（新增 `workflow-runs`、`workflow-runs/:runId`、`model-usage`）；`tokenUsage` 由"恒为 0"改为真实值（新增 `ModelCallLog`）；overview 补 `p95DurationMs` / `failedLast24h` / `modelCalls` |
| 4 | 新增 10 | `backend/src/chat-files/**` 此前**完全没有文档**，补齐「聊天页上传文件对话」模块（上传 → 解析 → 注入上下文 → AI 对话），含 Redis 降级、越权防护、视觉通道三个关键点 |
| 5 | 04 | `runStream` 初始化阶段补 `attachmentIds` → `resolveForChat` + `fileContext.build` 的附件处理链路；`ChatMessage` 补 `attachments` 关联 |
| 6 | 新增 11 | `backend/src/assistant/**` + `backend/src/platform-tools/**` 此前**完全没有文档**，补齐平台助理（识别判据 / 动态上下文 / 17 个工具 / 审计表 / 前端卡片） |
| 7 | 08 | MCP 章节**整节重写**：按传输 / 连接 / 工具 / 安全分层，补两种 transport 的握手流程、会话缓存、凭据加密、SSRF+DNS 校验；接口数 6 → **9** |
| 8 | 04 + 08 + README | **修正硬错误**：此前写「Agent 侧 MCP 未接入运行时」，实际 `AgentService` 已注入 `McpService` / `McpToolService` 并在 `runStream` 里加载 bindings。现统一为「MCP ✅ 已接入 / Skill ❌ 仍为预留」 |
| 9 | 01 | 表清单补 `GeneratedFile` / `ModelCallLog` / `PlatformOperationLog`，数量 15 → **23**；模块树补 `AssistantModule` |
| 10 | 05 | `mcpServerMap` → **`mcpBindings`**（重构后已改名），`executeWithTools` 补 `telemetry` 参数，第 4 步改为 `McpToolService.buildBindings()`（缓存优先） |
| 11 | 04 | 「系统预设 Agent」一节重写：`ensureSystemAgents()` 已委托 `PlatformAssistantService.ensure()`，不再硬编码创建 `meibus`；`runStream` 补平台助理分支与 `operation` / `file` 两个 SSE 事件 |
| 12 | 03 | 新增 **第九节 内容归一化**：`ai/content.util.ts` 的 `normalizeContentToString()`（把多模态 content parts 归一化成字符串，避免 `Expected String, provided Object` 落库报错），补 `ChatMessage.content` 类型说明与四处调用点 |
| 13 | 04 + 10 | `ChatMessage.content` 字段说明补「**始终是字符串**」及落库兜底；10 区分「输入侧多模态（images）」与「输出侧多模态（content parts）」，交叉引用 03 第九节 |
| 14 | 01 | **修正硬错误**：`DocumentChunk` 写「向量已移出」与 schema 矛盾——遗留列 `embedding vector(768)?` 仍在（手写迁移维护 + IVFFlat 索引），新版向量走版本物理表；PrismaService 补 driver adapter 说明（`$connect()` 在 `onModuleInit`，非构造函数）；过滤器 500 分支补 `describeInfraError()` |
| 15 | 02 | 补 JWT 有效期（`JWT_EXPIRES_IN ?? '7d'`）、DTO 校验规则表、`getMe()` 二次查库逻辑 |
| 16 | 03 | 补 `images` 视觉输入通道、`ChatOptions.telemetry` 与 `ModelCallLog` 埋点（新增专节）、`tool-args.util.ts`（parse/stringifyToolArguments）、usage 统计映射（Ollama `prompt_eval_count/eval_count`、OpenAI 仅 `total_tokens` 有值才返回）；修正 Authorization 头为条件添加、`normalizeBaseUrl` 剥三个后缀、`resolveModelRuntime` 返回值补 `capabilities` |
| 17 | 04 | **修正硬错误**：`ensureSystemAgents` 行号 `:182` → `:199`；MCP 路由行号 `:531/537`、`:725/727` → `:580-593`、`:827-860`；Agent 模型代码块 `temperature` 重复行删除；补遥测五级回退链与 `recordAgentCall`、`supportsStream` 流式降级、assistant tool_calls 落库、平台工具路由条件 `platformToolContext &&`、`file` 事件在 `tool_result` 之前 yield |
| 18 | 05 | **修正硬错误**：LLM 节点 `mcpService.findRuntimeConfigs()` → `findByIds()`（`:401`）；补 `WorkflowController`（`@Controller('workflow')` 无鉴权的调试直跑）、telemetry 注入与 `RunMonitorService`、`update()` 仅传 definition 才建版本、`remove()` 永久删除（级联 + 摘 Agent 绑定）、`executeWithTools` 空返回分支、Condition 右侧也 resolve、`errorCode` 字段、RAG 默认模板分支 |
| 19 | 06 | 补 `sanitizeText()` 三处清洗（22021 根因修复）、`POST /documents/:id/reprocess`、空文本预检（扫描件保护）、向量化遥测、整批前置维度校验；上传白名单 4 → **5** 个扩展名 |
| 20 | 07 | `resolveModelRuntime` / `resolveUserDefaultChatModel` 返回值补 `capabilities`；`testBeforeSave` 失败分支补 `models: []`；「新增的 4 个」→ **5 个** |
| 21 | 08 | **修正硬错误**：Dashboard 段落「Agent 聊天链路不写 ModelCallLog」已过时（`recordAgentCall` 已接入）；补 `readBuffer()`、`logRunComplete` 参数名 `totalMs` → `durationMs`、Friendship `searchUsers` |
| 22 | 09 | `sourceType` 4 → **5** 值（含 `export`）+ `POST /generate` 默认 `?? 'export'`；流程图补 `normalizeSpreadsheet()`；FilesModule 导出 2 → **3**；markdown 预览补返回 `text` |
| 23 | 10 | csv 解析器补上限 **500 行 / 60 列** |
| 24 | 教程 00~09 | 后端文件数 100 → **163**；队列三条 → **四条**（补 `chat-file-processing`）；目录树补 chat-files / files / assistant / platform-tools；业务模块 14 → **17**；auth 6 → **8** 个文件；schema 521 行 → **852** 行、19 → **25** model；「SSE 调试入口没按钮 / 轮询没超时兜底」两处过时描述删除（按钮与 `POLL_MAX_COUNT=150` 均已存在）；教程 08 补 `DELETE /workflows/:id`；教程 07 补整批前置维度校验、空文本预检、`retryFailedOnly` 未生效标注、local 落盘路径补 `<kbId>` 层；教程 09 补 `readBuffer`、`getDownloadUrl` local 返回 null、签名 try/catch |

> 仍在文档里但**代码尚未修**的缺口见下表（G2 / G3）。

### Skill / MCP 的接入现状（重要，别踩坑）

**MCP 有两条路是通的，Skill 只有一条**：

| 入口 | Skill | MCP |
|---|---|---|
| 工作流 LLM 节点 + BullMQ 异步执行 | ✅ 注入 System Prompt | ✅ `McpToolService.callTool()` 走 Function Calling |
| 工作流 LLM 节点 + 画布流式调试 | ✅ 注入 System Prompt | ❌ `executeStream()` 忽略 tools（缺口 G2） |
| **Agent 配置页** | ❌ 仅 CRUD，**已确认暂缓实现** | ✅ **已接入**：`runStream()` 把选中 Server 的工具合并进 ReAct 工具集（见 04） |

> 结论：
> - **要用 Skill** → 只能在画布的 LLM 节点上勾（在 Agent 里勾没用，字段会存进去但运行时不读）。
> - **要用 MCP** → Agent 配置页勾选**会生效**；画布上勾选则必须走 BullMQ 异步执行，流式调试仍调不到。

### 其余已知实现缺口（文档已标注，代码尚未修）

| # | 缺口 | 影响 |
|---|---|---|
| G2 | `LLMNodeExecutor.executeStream()` 忽略 `tools` / `mcpBindings` | 画布上**流式调试运行**的 LLM 节点调不到 MCP 工具，只有 BullMQ 异步路径可以 |
| G3 | RAG 检索 SQL 未过滤 `Document.status` | PROCESSING / FAILED 文档已入库的 chunk 也可能被检索出来 |

> G1 已**拆分处理**：Agent 侧 **MCP 已接入运行时**（不再是缺口，04/08 均已标注 ✅）；
> 剩下的 **Skill 未接入**部分由产品确认**暂缓实现**，转为"预留字段"在 04/08 中标注，不再是待办。

### 最容易踩的 10 个坑

1. `StorageService` 的方法叫 **`upload()`**，返回 `{ key, size }`——不是 `save()` 返回字符串
2. 加密密钥环境变量是 **`LLM_CONFIG_ENCRYPTION_KEY`**，不是 `ENCRYPTION_KEY`
3. `WorkspaceMember` **没有 role 字段**，role 是按 `userId === workspace.ownerId` 现算的
4. Agent ReAct 循环里最终答案会**生成两遍**（先整段推、再流式重生成）
5. HTTP 节点的 **4xx/5xx 不抛错**（`validateStatus: () => true`），会作为正常响应返回
6. **生成的 docx 前端预览正常 ≠ Word 能打开**：`[Content_Types].xml` 必须在 zip 首位，且 `w:numId` 不能是 `{...}` 占位符。详见 **09**第六节
7. **聊天附件 ≠ 知识库文档**：聊天页上传的附件**不向量化、不进 RAG**，只在当轮对话里作为上下文。想长期检索请走知识库上传。详见 **10**第一节
8. **`ChatAttachment` 不持久化 `previewType`**：历史消息的附件要用扩展名兜底推导预览类型（前端 `previewTypeFromExt()`），否则 PDF 可能被当纯文本渲染。详见 **10**第八节
9. **平台助理的识别判据是 `isSystem && isDefault`，不是名字**：名字可以被改，标识不能。`Agent.type` 仍是 `'CUSTOM'`，别去加枚举值。详见 **11**第三节
10. **Agent 里勾 MCP 会生效，勾 Skill 不会**：MCP 已接入运行时，Skill 仍是预留字段（产品确认暂缓）。详见 **04**第一节的接入状态表
