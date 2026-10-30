# AI WorkFlow Studio — 后端代码逻辑文档

> 面向**小白开发者**的代码讲解文档，按业务模块拆分，覆盖每一条后端业务逻辑的入参、出参、中间处理和调用链路。

---

## 文档目录

| 序号 | 文件 | 覆盖范围 | 读完你应该能回答 |
|---|---|---|---|
| 01 | [项目架构与入口](./01-项目架构与入口.md) | main.ts / app.module.ts / PrismaService / StorageService / EncryptionService | NestJS 怎么启动？全局依赖怎么注入？数据库表有哪些？ |
| 02 | [Auth 认证模块](./02-Auth认证模块.md) | AuthService / JwtStrategy / JwtAuthGuard | 注册登录完整流程？JWT 怎么生成和校验？为什么 validate 里还要查数据库？ |
| 03 | [AI Provider 大模型接入层](./03-AI%20Provider大模型接入层.md) | AiProvider 接口 / OllamaProvider / OpenAICompatibleProvider / ProviderFactory | AI_PROVIDER Symbol 怎么变成真实大模型？2 种 Provider 怎么发 HTTP 请求？流式和非流式怎么解析？为什么 DeepSeek 没有独立类？ |
| 04 | [Agent 智能体模块](./04-Agent智能体模块.md) | AgentService / runStream ReAct 循环 / **平台助理分支** / 工具三级路由（平台 → MCP → ToolRegistry）/ **内置 `web_search`** / ChatSession | ReAct 循环每轮发生什么？工具怎么注册和路由？平台助理怎么接管默认 Agent？联网搜索为什么做成内置工具？ChatSession 怎么持久化？ |
| 05 | [工作流引擎](./05-工作流引擎.md) | WorkflowEngine / NodeExecutorRegistry / 8 种 Executor / VariableService / WorkflowsService / BullMQ | 画布定义怎么变成可执行的？8 种节点各自做什么？变量模板 {{xxx}} 怎么解析？Condition 怎么选分支？ |
| 06 | [知识库与 RAG](./06-知识库与RAG.md) | KnowledgeService / DocumentProcessor / DocumentParser / EmbeddingService / VectorStoreService / KnowledgeRetrievalService | 文档上传后怎么变成向量？pgvector 检索有几种模式？RRF 融合怎么工作？ |
| 07 | [LLM 模型配置管理](./07-LLM模型配置管理.md) | LlmConfigService / 加密存储 / resolveModelRuntime() | API Key 怎么保护？运行时怎么动态绑定 Provider？Agent 怎么从本地 Ollama 切到云端 DeepSeek？ |
| 08 | [MCP-Skill-Storage-其他模块](./08-MCP-Skill-Storage-其他模块.md) | McpService / SkillService / StorageService / Workspace / Dashboard / Friendship | MCP Server 怎么被 LLM 调用？Skill 是什么？七牛云怎么切换？Workspace 权限模型是怎样的？ |
| 09 | [文件生成模块](./09-文件生成模块.md) | FilesService / FileGeneratorService / FileStorageService / FilePreviewService / 5 个生成器 / word.repair | AI 怎么真的产出可下载的 Word/Excel/PDF？预览数据怎么来的？为什么 Word 打不开生成的 docx？ |
| 10 | [聊天文件上传模块](./10-聊天文件上传模块.md) | ChatFilesService / FileParserService / FileContextService / 6 个解析器 / BullMQ 解析 Worker | 用户上传的 PDF/Word/Excel/图片怎么变成 AI 上下文？附件为什么不上知识库？Redis 挂了还能用吗？ |
| 11 | [平台助理](./11-平台助理.md) | PlatformAssistantService / PlatformToolsService / 19 个平台工具 / PlatformOperationLog / 聊天页操作卡片 | 默认聊天 Agent 怎么变成「能操作平台」的？模型生成的 JSON 怎么防止直接落库？userId 为什么不可伪造？审计表为什么和 trail 分开？ |
| 12 | [人格与记忆模块](./12-人格与记忆模块.md) | AgentPersona / PersonaService / 四段式 Prompt 装配 / MemoryService / MemoryWriterService / 3D 记忆网络 | 「不承认自己是程序」为什么不会削弱权限？人格为什么不塞进 Agent 表？记忆向量为什么不用 pgvector？沉淀怎么做到不拖慢对话？ |

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

本套文档已对照 `backend/src/**` 与 `prisma/schema.prisma` 逐方法核验过。**2026-10-29 全量复核**：01~12 逐篇重跑
「数字 / 名称 / 行为」三类校验，本轮改掉 8 处与代码不符的描述（见修订记录 #31）；历史问题一律按
「已解决即删除」处理，明细看 git 历史。
**仍未闭环的代码侧缺口只剩 2 项**（G2 流式 LLM 节点不支持 MCP 工具、G3 RAG 不过滤文档状态）。
Agent 侧 Skill 已于 **2026-10-30 接入运行时**（不再是暂缓项），详见 **[后端代码逻辑审查报告](../后端代码逻辑审查报告.md)**。

### 本次更新的修订记录（对照当前代码重新核验）

| # | 位置 | 修订内容 |
|---|---|---|
| 1 | 新增 09 | `backend/src/files/**` 此前**完全没有文档**，补齐文件生成模块的完整链路（含 docx 兼容性这一最大坑） |
| 2 | 04 | `Agent` 模型缺 `enableFileGeneration`；`ToolRegistry` 缺 `generate_file` 路由（原来只写了 workflow / knowledge 两个工具） |
| 3 | 08 - Dashboard | 接口数 7 → **10**（新增 `workflow-runs`、`workflow-runs/:runId`、`model-usage`）；`tokenUsage` 由"恒为 0"改为真实值（新增 `ModelCallLog`）；overview 补 `p95DurationMs` / `failedLast24h` / `modelCalls` |
| 4 | 新增 10 | `backend/src/chat-files/**` 此前**完全没有文档**，补齐「聊天页上传文件对话」模块（上传 → 解析 → 注入上下文 → AI 对话），含 Redis 降级、越权防护、视觉通道三个关键点 |
| 5 | 04 | `runStream` 初始化阶段补 `attachmentIds` → `resolveForChat` + `fileContext.build` 的附件处理链路；`ChatMessage` 补 `attachments` 关联 |
| 6 | 新增 11 | `backend/src/assistant/**` + `backend/src/platform-tools/**` 此前**完全没有文档**，补齐平台助理（识别判据 / 动态上下文 / 19 个工具 / 审计表 / 前端卡片） |
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
| 25 | 新增 12 | `backend/src/persona/**` + `backend/src/memory/**` 此前**完全没有文档**，补齐「平台助理人格化 + 长期记忆」：四段式 Prompt 装配（平台职责 → 人格表达层 → 记忆片段 → 动态上下文）、人格边界声明为什么能兜住「不承认自己是程序」、人格为什么不塞 `Agent` 表、记忆向量为什么用 `Float[]` + 应用层余弦而不用 pgvector、召回打分公式、沉淀的 fire-and-forget + 3 分钟冷却、3D 网络的 InstancedMesh 渲染对照表、7 个常见坑、已知边界 M1~M6 |
| 26 | 01 + 教程 00 | 表清单 25 → **31** 张（补 `AgentPersona` / `Memory` / `MemoryLink` / `MemorySetting` / `DesktopPetSettings` / `RefreshToken`）；模块树补 `PersonaModule` / `MemoryModule` 并说明「`PersonaModule` 只依赖 `PrismaModule` 是为了避开与 `AssistantModule` 的循环依赖」；教程 00 接口数 126 → **138**（人格 4 + 记忆 8）、新增 §3.14 接口表、前端技术栈补 `three`、后端文件数 163 → **175**、业务模块 17 → **19**、前端源文件 60 → **66**、目录树补 `persona/` `memory/` `components/memory/` `views/memory/` `agents/components/PersonaPanel.vue`、术语表补「人格 / 记忆召回 / 记忆沉淀」、坑表补 #29 #30 |
| 27 | 04 + 12 | **修正行为缺陷**：ReAct 分支 B 里 `toolCalls.length === 0` 时原本「先推整段 content，再调一次 `streamChat` 重新生成」，同一轮多花一次模型调用（实测 2.8s → 5.9s），且两次生成内容不一致会导致前端气泡**突变**、累积长度**回退**（102 → 1）。改为 `streamAsTypewriter(result.content)` 对已有答案切片推送（3 字/片，整段约 600ms），只保留「content 为空才退回 streamChat」的兜底。04 新增「为什么不再二次调用模型」小节；12 §11.5 补 SSE 空闲兜底、气泡光标两条坑 |
| 28 | 01 + 12 | 新增 `DesktopPetModule`（`src/desktop-pet/`，1 个接口）：浏览器不允许网页启动本地程序，所以「网页点一下打开桌宠」由后端 `spawn` 本机 Electron。01 模块树补该模块并说明零依赖；12 §11 新增 **11.0 怎么启动**（两条路 / 目录探测 / 删 `ELECTRON_RUN_AS_NODE` / detached）、补 `npm start` 在本机 GPU 崩溃的修法（`no-sandbox` + `disable-gpu` + `in-process-gpu`） |
| 29 | 12 | 补 **登录态交接**（12 §11.0 新增小节）：`launch` 把 JWT 写进 `%TEMP%/xiaodie-handoff-<uuid>.json`（0600、60s TTL），只把**路径**放进 `env.XIAODIE_HANDOFF`，桌宠读完即删 → 点开就是登录状态、不弹面板。关键细节：**交接文件必须在拿单实例锁之前读**，否则桌宠已开着时第二个进程拿不到锁就退出、env 传不到第一个实例（实测会留下含完整 token 的文件 60 秒，且换账号失效），改用 `requestSingleInstanceLock({ handoff })` → `second-instance` 第 4 个参数转交 |
| 30 | 全局 | **同步第七轮（2026-10-28）**：实测后端 **141** 接口 / **20** Controller / **31** 表 / **25** 迁移 / **181** 个 `.ts` / `schema.prisma` **1029** 行 / 注册模块 **21**；补 **TTS 模块**（`/tts/synthesize` 1 接口，零依赖，桌宠后端兜底）到 08 第九节、教程 00 §3.16、教程 08 §6.10、命令.md 模块表；MCP 接口表补 `GET /mcp-servers/capabilities`（共 10 个）；模块树补 `TtsModule`；各基线数字（138/139→141、18→20、852→1029、175/178→181、23→25）统一对齐 |
| 31 | 03 / 04 / 06 / 10 / 12 / 本页 | **同步第八轮（2026-10-29）全量复核**：改掉 8 处与代码不符的描述 —— 遥测「前后各记一次」→「结束后记一条」、tool_calls 解析的 `parse`/`stringify` 方向、Provider 请求体写死的 `temperature: 0.7`、`ARCHIVED` 版本被标成可激活、附件上下文模板、记忆沉淀分支数、summary「超长丢弃」→「截断到 120 字」；本页「最容易踩的坑」#4（最终答案生成两遍）已随 `streamAsTypewriter` 改造过时，改写为「打字机是后端切片模拟」；审查报告删掉已修复条目索引，只留 G2 / G3 / Skill 暂缓 |
| 32 | 03 / 04 / 06 / 08 / 10 / 00 / 02 / 12 / 11 / 本页 | **Provider 层两项结构调整（2026-10-29）**：<br>① **删除 `DeepSeekProvider` 子类** —— 只有构造函数 4 行有效代码、零方法覆写，与 `openai` 的「工厂传参」写法不对称。`ai/providers/` 从 3 个实现类收敛到 **2 个**（`OllamaProvider` / `OpenAICompatibleProvider`），承载 4 种 `LlmProviderType`。03 第五节整节改写为「为什么 DeepSeek 没有独立类」+ 两个必须避开的坑（`DEFAULT_BASE_URL.deepseek` 不能删、第三参数 `name` 不能省）；工厂里 `openai` / `deepseek` 两个 case 也合并成一个（`DEFAULT_BASE_URL[provider]` + `provider` 当 name），`openai-compatible` 因无默认地址仍独立。<br>② **新增 reasoning（推理过程）双通道** —— `AiProvider.streamChat` 返回值从 `AsyncGenerator<string>` 改为 `AsyncGenerator<ChatStreamChunk>`（`{type:'content'\|'reasoning', text}`），非流式加 `ChatResult.reasoning?` / `ToolChatResult.reasoning?`；字段探测 `reasoning_content` / `reasoning` / Ollama `message.thinking`。Agent SSE 新增 `reasoning` 事件（累积语义），推理全文作为一条 trail 步骤落库（**无新字段、无迁移**）。03 新增「为什么流式要返回分片」小节，04 补事件表并强调 **`thinking`（后端自造状态）≠ `reasoning`（模型真实思维链）**，06/08 补前端渲染说明，10 补接口签名，12 补桌宠 `reasoning` 期间的思考动画与 SSE 空闲兜底 |
| 33 | 04 / 08 / 11 / 01 / 本页 | **新增内置联网搜索 `web_search` + 系统助理放开 Skill/MCP 绑定（2026-10-30）**：<br>① **`web_search`** —— 新增 `backend/src/web-search/`（`WebSearchService` 做 provider 抽象与归一化，`WebSearchModule` 只读环境变量、不碰数据库），`agent/tools/web-search.tool.ts` 出 ToolDefinition；`ToolRegistry.buildDefinitions()` 按 `isAvailable()`（= 配了 `BOCHA_API_KEY` / `TAVILY_API_KEY`）决定要不要 push。04 新增 **§三·六** 完整章节（为什么不做成 MCP、两家的字段差异对照表、摘要截断 520 / 注入提示 / 失败不抛错三个取舍、博查 `HTTP 200 + body.code≠200` 的坑）。<br>② **系统平台助理放开 `skillIds` / `mcpServerIds`** —— `SYSTEM_AGENT_EDITABLE_FIELDS` 从 3 个字段扩到 5 个；**关键**：`assertOwnsSkills()` / `assertOwnsMcpServers()` 原本只写在 `else`（用户 Agent）分支里，必须提到 `if (agent.isSystem)` 之前，否则系统助理能绑别人的 Skill 指令与 MCP 凭据。04 权限模型表、08 两处接入状态、11 新增 **§五·二**、01 模块树说明同步；本页坑表 #11 改写、新增 #14。 |

> 仍在文档里但**代码尚未修**的缺口见下表（G2 / G3）。

### Skill / MCP 的接入现状（重要，别踩坑）

**MCP 有两条路是通的，Skill 只有一条**：

| 入口 | Skill | MCP |
|---|---|---|
| 工作流 LLM 节点 + BullMQ 异步执行 | ✅ 注入 System Prompt | ✅ `McpToolService.callTool()` 走 Function Calling |
| 工作流 LLM 节点 + 画布流式调试 | ✅ 注入 System Prompt | ❌ `executeStream()` 忽略 tools（缺口 G2） |
| **Agent 配置页** | ✅ **已接入**：`buildSkillSection()` 把 `instructions` 拼进 System Prompt（见 04） | ✅ **已接入**：配置页有「MCP 工具」区块，`runStream()` 把选中 Server 的工具合并进 ReAct 工具集（见 04） |
| **系统平台助理**（同一套字段） | ✅ **已接入**（2026-10-30 放开，`SYSTEM_AGENT_EDITABLE_FIELDS` 含 `skillIds`） | ✅ **已接入**（同上，含 `mcpServerIds`） |

> 结论：
> - **要用 Skill** → Agent 配置页勾选**会生效**；画布 LLM 节点勾选同样生效，两条路径互不影响。
> - **要用 MCP** → Agent 配置页勾选**会生效**；画布上勾选则必须走 BullMQ 异步执行，流式调试仍调不到。

### 其余已知实现缺口（文档已标注，代码尚未修）

| # | 缺口 | 影响 |
|---|---|---|
| G2 | `LLMNodeExecutor.executeStream()` 忽略 `tools` / `mcpBindings` | 画布上**流式调试运行**的 LLM 节点调不到 MCP 工具，只有 BullMQ 异步路径可以 |
| G3 | RAG 检索 SQL 未过滤 `Document.status` | PROCESSING / FAILED 文档已入库的 chunk 也可能被检索出来 |

> G1 已**完全闭环**：Agent 侧 **MCP 与 Skill 均已接入运行时**（04/08 均已标注 ✅），
> 不再是待办；Skill 的 `WORKFLOW` / `TOOL` 两种 type 仍只有 `instructions` 参与注入，属于后续增强。

### 最容易踩的 14 个坑

1. `StorageService` 的方法叫 **`upload()`**，返回 `{ key, size }`——不是 `save()` 返回字符串
2. 加密密钥环境变量是 **`LLM_CONFIG_ENCRYPTION_KEY`**，不是 `ENCRYPTION_KEY`
3. `WorkspaceMember` **没有 role 字段**，role 是按 `userId === workspace.ownerId` 现算的
4. Agent 有工具时的「打字机效果」是**后端切片模拟**的（`streamAsTypewriter`，3 字/片），不是真流式 —— 早期「先推整段再 `streamChat` 重生成」的做法已废弃（多花一次调用、内容会突变、长度会回退）
5. HTTP 节点的 **4xx/5xx 不抛错**（`validateStatus: () => true`），会作为正常响应返回
6. **生成的 docx 前端预览正常 ≠ Word 能打开**：`[Content_Types].xml` 必须在 zip 首位，且 `w:numId` 不能是 `{...}` 占位符。详见 **09**第六节
7. **聊天附件 ≠ 知识库文档**：聊天页上传的附件**不向量化、不进 RAG**，只在当轮对话里作为上下文。想长期检索请走知识库上传。详见 **10**第一节
8. **`ChatAttachment` 不持久化 `previewType`**：历史消息的附件要用扩展名兜底推导预览类型（前端 `previewTypeFromExt()`），否则 PDF 可能被当纯文本渲染。详见 **10**第八节
9. **平台助理的识别判据是 `isSystem && isDefault`，不是名字**：名字可以被改，标识不能。`Agent.type` 仍是 `'CUSTOM'`，别去加枚举值。详见 **11**第三节
10. **Agent 里勾 MCP 和 Skill 都会生效**：两者都已接入运行时，但 Skill 注入按 `ownerId` 过滤，绑定别人的 Skill 会被拒（`assertOwnsSkills()`）。详见 **04**第一节的接入状态表
11. **人格别往 `Agent` 表塞**：系统 Agent 的 `PATCH` 只认 `llmModelId / model / temperature / skillIds / mcpServerIds`（`SYSTEM_AGENT_EDITABLE_FIELDS`），多带一个字段整个请求 400。人格走独立表 `AgentPersona` + 自己的接口。详见 **12**
12. **记忆列表接口不带 `content`**：`GET /memories` 的 `select` 刻意排除正文（只给 `summary`），看全文必须单独 `GET /memories/:id`；3D 图一次取 500 个节点，带正文会把响应撑到几 MB。详见 **12**
13. **推理过程（`reasoning`）和正文（`content`）是两条流，绝不能混**：`streamChat` 返回的是 `ChatStreamChunk` 联合类型，不是字符串。思考型模型的 `reasoning_content` / `message.thinking` 一旦拼进正文，就会写进 `ChatMessage.content`、被桌宠念出来、被工作流节点当成输出。只要正文的调用方套 `contentOnly()`。详见 **03**第二节
14. **内置工具的开关在环境变量，不在数据库**：`web_search` 没有 `Agent.enableWebSearch` 这种字段 —— 配了 `BOCHA_API_KEY` / `TAVILY_API_KEY` 就对**所有** Agent（含系统助理）生效，没配则工具定义根本不进 `tools` 数组。想做「按 Agent 开关」得加迁移，别指望前端页面能关。详见 **04**§三·六
