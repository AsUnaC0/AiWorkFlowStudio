# AI WorkFlow Studio — 后端代码逻辑文档

> 面向**小白开发者**的代码讲解文档，按业务模块拆分，覆盖每一条后端业务逻辑的入参、出参、中间处理和调用链路。

---

## 文档目录

| 序号 | 文件 | 覆盖范围 | 读完你应该能回答 |
|---|---|---|---|
| 01 | [项目架构与入口](./01-项目架构与入口.md) | main.ts / app.module.ts / PrismaService / StorageService / EncryptionService | NestJS 怎么启动？全局依赖怎么注入？数据库表有哪些？ |
| 02 | [Auth 认证模块](./02-Auth认证模块.md) | AuthService / JwtStrategy / JwtAuthGuard | 注册登录完整流程？JWT 怎么生成和校验？为什么 validate 里还要查数据库？ |
| 03 | [AI Provider 大模型接入层](./03-AI%20Provider大模型接入层.md) | AiProvider 接口 / OllamaProvider / OpenAICompatibleProvider / DeepSeekProvider / ProviderFactory | AI_PROVIDER Symbol 怎么变成真实大模型？3 种 Provider 怎么发 HTTP 请求？流式和非流式怎么解析？ |
| 04 | [Agent 智能体模块](./04-Agent智能体模块.md) | AgentService / runStream ReAct 循环 / ToolRegistry / WorkflowTool / KnowledgeTool / GenerateFileTool | ReAct 循环每轮发生什么？工具怎么注册和路由？ChatSession 怎么持久化？ |
| 05 | [工作流引擎](./05-工作流引擎.md) | WorkflowEngine / NodeExecutorRegistry / 8 种 Executor / VariableService / WorkflowsService / BullMQ | 画布定义怎么变成可执行的？8 种节点各自做什么？变量模板 {{xxx}} 怎么解析？Condition 怎么选分支？ |
| 06 | [知识库与 RAG](./06-知识库与RAG.md) | KnowledgeService / DocumentProcessor / DocumentParser / EmbeddingService / VectorStoreService / KnowledgeRetrievalService | 文档上传后怎么变成向量？pgvector 检索有几种模式？RRF 融合怎么工作？ |
| 07 | [LLM 模型配置管理](./07-LLM模型配置管理.md) | LlmConfigService / 加密存储 / resolveModelRuntime() | API Key 怎么保护？运行时怎么动态绑定 Provider？Agent 怎么从本地 Ollama 切到云端 DeepSeek？ |
| 08 | [MCP-Skill-Storage-其他模块](./08-MCP-Skill-Storage-其他模块.md) | McpService / SkillService / StorageService / Workspace / Dashboard / Friendship | MCP Server 怎么被 LLM 调用？Skill 是什么？七牛云怎么切换？Workspace 权限模型是怎样的？ |
| 09 | [文件生成模块](./09-文件生成模块.md) | FilesService / FileGeneratorService / FileStorageService / FilePreviewService / 5 个生成器 / word.repair | AI 怎么真的产出可下载的 Word/Excel/PDF？预览数据怎么来的？为什么 Word 打不开生成的 docx？ |

---

## 代码路径约定

文中所有 `backend/src/xxx.ts` 路径均相对于项目根目录 `c:\Users\meibus\Desktop\AI WorkFlow Studio`。

## 推荐阅读顺序

想快速上手 → **01 → 03 → 04 → 05**（架构 → 大模型层 → Agent 调用 → 工作流引擎）

想做 RAG → **06 → 03 → 04**（知识库 → Provider → Agent Knowledge Tool）

想接云端模型 → **07 → 03**（配置管理 → Provider 实现）

想加新节点类型 → **05 → 03**（Engine + Executor 模式 → 需要调 LLM 时看 Provider）

想加新导出格式 / 排查"Word 打不开" → **09 → 08**（文件生成模块 → StorageService）

---

## 本文档的准确性说明

本套文档已对照 `backend/src/**` 与 `prisma/schema.prisma` 逐方法核验过，详见 **[后端代码逻辑审查报告](./后端代码逻辑审查报告.md)**（含 8 处硬性错误的修订记录）。

### 本次更新的修订记录（对照当前代码重新核验）

| # | 位置 | 修订内容 |
|---|---|---|
| 1 | 新增 09 | `backend/src/files/**` 此前**完全没有文档**，补齐文件生成模块的完整链路（含 docx 兼容性这一最大坑） |
| 2 | 04 | `Agent` 模型缺 `enableFileGeneration`；`ToolRegistry` 缺 `generate_file` 路由（原来只写了 workflow / knowledge 两个工具） |
| 3 | 08 - Dashboard | 接口数 7 → **10**（新增 `workflow-runs`、`workflow-runs/:runId`、`model-usage`）；`tokenUsage` 由"恒为 0"改为真实值（新增 `ModelCallLog`）；overview 补 `p95DurationMs` / `failedLast24h` / `modelCalls` |

> 仍在文档里但**代码尚未修**的缺口见下表（G2 / G3）。

### Skill / MCP 的接入现状（重要，别踩坑）

**只有「工作流 LLM 节点」这一条路是通的**，其余都是预留字段：

| 入口 | Skill | MCP |
|---|---|---|
| 工作流 LLM 节点 + BullMQ 异步执行 | ✅ 注入 System Prompt | ✅ Function Calling 调 `tools/call` |
| 工作流 LLM 节点 + 画布流式调试 | ✅ 注入 System Prompt | ❌ `executeStream()` 忽略 tools |
| Agent 配置页 | ❌ 仅 CRUD，**已确认暂缓实现** | ❌ 仅 CRUD，**已确认暂缓实现** |

> 结论：**要用 Skill / MCP，就在画布的 LLM 节点上勾，并走异步执行**。在 Agent 里勾是没用的（字段会存进去，但运行时不读）。

### 其余已知实现缺口（文档已标注，代码尚未修）

| # | 缺口 | 影响 |
|---|---|---|
| G2 | `LLMNodeExecutor.executeStream()` 忽略 `tools` / `mcpServerMap` | 画布上**流式调试运行**的 LLM 节点调不到 MCP 工具，只有 BullMQ 异步路径可以 |
| G3 | RAG 检索 SQL 未过滤 `Document.status` | PROCESSING / FAILED 文档已入库的 chunk 也可能被检索出来 |

> G1（Agent 侧 Skill/MCP 未接入）已由产品确认**暂缓实现**，不再是待办缺口，转为"预留字段"在 04/08 中标注。

### 最容易踩的 6 个坑

1. `StorageService` 的方法叫 **`upload()`**，返回 `{ key, size }`——不是 `save()` 返回字符串
2. 加密密钥环境变量是 **`LLM_CONFIG_ENCRYPTION_KEY`**，不是 `ENCRYPTION_KEY`
3. `WorkspaceMember` **没有 role 字段**，role 是按 `userId === workspace.ownerId` 现算的
4. Agent ReAct 循环里最终答案会**生成两遍**（先整段推、再流式重生成）
5. HTTP 节点的 **4xx/5xx 不抛错**（`validateStatus: () => true`），会作为正常响应返回
6. **生成的 docx 前端预览正常 ≠ Word 能打开**：`[Content_Types].xml` 必须在 zip 首位，且 `w:numId` 不能是 `{...}` 占位符。详见 **09**第六节
