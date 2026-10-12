# 08 - MCP Server + Skill + 存储 + 其他模块

> 阅读本文后，你应该能回答：MCP Server 怎么在 LLM 节点里被调用？Skill 是什么？StorageService 怎么切换本地/七牛云？Dashboard 统计了什么？Workspace 的成员权限模型是怎样的？

---

## 一、MCP Server 模块

**文件路径**：`backend/src/mcp/mcp.service.ts`

### 接入状态（先看这个）

| 位置 | 状态 |
|---|---|
| **工作流 LLM 节点**（画布勾选 `mcpServerIds`） | ✅ **已接入**。非流式 `execute()` 会把 availableTools 转成 ToolDefinition，LLM 调工具时走 `callTool()` |
| 流式 / 画布调试运行（`executeStream()`） | ❌ 未接入。忽略 tools，见 [05](./05-工作流引擎.md) |
| **Agent 配置页**（`Agent.mcpServerIds`） | ❌ **仅 CRUD，未接入运行时**——已确认暂缓实现，字段预留 |

也就是说：**要用 MCP，就在工作流的 LLM 节点上勾**，并且走 BullMQ 异步执行（不是画布上的流式调试）。

### 数据模型

```typescript
model McpServer {
  id             String   @id
  ownerId        String
  name           String
  description    String?
  transport      String   @default("STREAMABLE_HTTP")  // "SSE" | "STREAMABLE_HTTP"
  serverUrl      String                                 // MCP Server 地址
  authType       String   @default("NONE")              // "NONE" | "API_KEY" | "BEARER_TOKEN"
  credentials    Json?    // { apiKey?, bearerToken? } —— ⚠️ 目前是【明文】JSON，未加密
  availableTools Json?    // [{ name, description, inputSchema }]，连接成功后缓存
  status         String   @default("DISCONNECTED")      // DISCONNECTED | CONNECTED | ERROR
  lastError      String?
}
```

**三个容易记错的点**：
1. 枚举值是 **`STREAMABLE_HTTP`**，不是 "http"；`SSE` 只是存得下，**工具调用时直接抛错**（见下）
2. `authType` 是 `NONE / API_KEY / BEARER_TOKEN`，不是 "bearer"/"api_key"
3. `credentials` **没有走 EncryptionService**，是 `buildCredentials()` 直接明文入库（schema 注释里也标了"生产环境应加密存储"）。LLM 的 API Key 是加密的，MCP 的凭据不是——这是个不一致的地方。

### 与 LLMNodeExecutor 的集成

LLM 节点的 `createParams()` 方法里：

```typescript
// 1. 查 MCP Server 表
const servers = await this.mcpService.findByIds(config.mcpServerIds);

// 2. 把每个 server 的 availableTools 转成 ToolDefinition[]
for (const tool of server.availableTools) {
  tools.push({ type: 'function', function: { name, description, parameters } });
  mcpServerMap.set(tool.name, serverInfo);   // 名字 → 连接信息
}

// 3. executeWithTools() 里执行
const server = mcpServerMap.get(call.function.name);
const toolResult = await this.mcpService.callTool(server, call.function.name, args);
```

### callTool() — 一次调用要发 3 个 HTTP 请求

MCP（Model Context Protocol）是 JSON-RPC 2.0 over HTTP。本项目实现的是 **Streamable HTTP** 传输，`callTool()` 每次都会完整跑一遍握手：

```
① POST {serverUrl}  { jsonrpc:'2.0', id:1, method:'initialize',
                      params:{ protocolVersion:'2024-11-05', capabilities:{}, clientInfo:{...} } }
② POST {serverUrl}  { jsonrpc:'2.0', method:'notifications/initialized' }   // 通知，不等响应
③ POST {serverUrl}  { jsonrpc:'2.0', id:3, method:'tools/call',
                      params:{ name: toolName, arguments: args } }
```

三步都带 `Accept: application/json, text/event-stream`。

**响应解析**（`parseMcpResponse`）：看 `content-type`
- 含 `text/event-stream` → 按行找 `data: ` 前缀再 `JSON.parse`（找不到有效数据就抛错）
- 否则直接 `response.json()`

**鉴权头**（`buildHeaders`）：
- `API_KEY` → `X-API-Key: <credentials.apiKey>`
- `BEARER_TOKEN` → `Authorization: Bearer <credentials.bearerToken>`
- `NONE` → 不带

**结果处理**：
- `callResult.error` 有值 → 抛 `工具调用失败: {...}`
- `result.isError === true` → 抛 `content[0].text`
- 成功 → 取 `content` 数组里所有 `type === 'text'` 的 `text`，用 `\n` 拼起来返回

> ⚠️ **SSE 传输不支持工具调用**：`callTool()` 开头就是
> `if (server.transport === 'SSE') throw new Error('SSE 传输方式暂不支持工具调用，请使用 Streamable HTTP')`。
> `fetchTools()` 同样拒绝对 SSE 做连接测试。

### testConnection() — 连接测试并缓存工具

```
fetchTools() 走 initialize → notifications/initialized → tools/list
  成功 → status=CONNECTED, lastError=null, availableTools=tools  返回 { success:true, tools, message:'连接成功，发现 N 个可用工具' }
  失败 → status=ERROR,     lastError=msg,  availableTools=null    返回 { success:false, tools:[], message:msg }
```

另外 `update()` 时如果改了 `serverUrl` 或 `authType`，会**重置** `status='DISCONNECTED'`、`lastError=null`、`availableTools=null`——因为旧的工具列表已经不可信了。

---

## 二、Skill 模块

**文件路径**：`backend/src/skill/skill.service.ts`

### 接入状态（先看这个）

| 位置 | 状态 |
|---|---|
| **工作流 LLM 节点**（画布勾选 `skillIds`） | ✅ **已接入**。`createParams()` 取 `instructions` 追加进 System Prompt |
| **Agent 配置页**（`Agent.skillIds`） | ❌ **仅 CRUD，未接入运行时**——已确认暂缓实现，字段预留 |

> Skill 的 `WORKFLOW` / `TOOL` 两种 `type`（对应 `workflowId` / `mcpServerId`+`mcpToolName`）**也还没有执行分支**，目前只有 `instructions`（PROMPT 语义）会被用到。同样属于暂缓项。

### 数据模型

```typescript
model Skill {
  id           String   @id
  ownerId      String
  name         String
  description  String?
  type         String   @default("PROMPT")   // "PROMPT" | "TOOL" | "WORKFLOW"
  instructions String?                        // ← 核心：追加到 System Prompt 的指令文本（可选字段！）
  inputSchema  Json?                          // 输入参数 schema（JSON Schema）
  outputFormat String   @default("Markdown")  // Markdown | JSON | Text
  workflowId   String?                        // WORKFLOW 类型：绑定的 Workflow
  mcpServerId  String?                        // TOOL 类型：绑定的 McpServer
  mcpToolName  String?                        // TOOL 类型：MCP 工具名
}
```

### 注入时机 —— **只有 LLM 节点会注入**

注入发生在 `LLMNodeExecutor.createParams()`：

```typescript
if (Array.isArray(config.skillIds) && config.skillIds.length > 0) {
  const skills = await this.skillService.findByIds(config.skillIds);
  const validSkills = skills.filter(s => s.instructions);      // 只取有指令的
  if (validSkills.length > 0) {
    skillInstructions = validSkills
      .map(s => `## Skill: ${s.name}\n${s.instructions}`)
      .join('\n\n');
  }
}

// 在 RAG 上下文注入之后、构造 messages 之前，追加到 System Prompt 末尾
if (skillInstructions) {
  finalSystemPrompt = finalSystemPrompt
    ? `${finalSystemPrompt}\n\n--- Skills ---\n${skillInstructions}`
    : `--- Skills ---\n${skillInstructions}`;
}
```

> 📌 **Agent 侧仅 CRUD，未接入运行时——已确认暂缓实现，不是 bug**。
> `Agent.skillIds` 字段存在且能存能查，但 `AgentService` **没有注入 SkillService**，运行时从不读取。
> 也就是说：**在 Agent 配置页勾选 Skill 不会生效**，只有在画布上给 LLM 节点勾选 Skill 才会注入。
> `Agent.mcpServerIds` 同理。

**Skill 本质上就是一段可复用的 System Prompt 片段**——比如写一个"代码审查" Skill，保存固定的审查标准，LLM 节点勾选后自动注入。
注意 schema 虽然定义了 `WORKFLOW` / `TOOL` 两种类型（对应 `workflowId` / `mcpServerId` + `mcpToolName`），但当前注入逻辑**只处理 `instructions`**，那两个类型还没有对应的执行分支。

---

## 三、StorageService — 统一存储

**文件路径**：`backend/src/storage/storage.service.ts`

### 接口

```typescript
class StorageService {
  readonly type: 'local' | 'qiniu';

  // ⚠️ 方法名是 upload，不是 save；返回 { key, size }，不是字符串
  //   local 的 key = 绝对路径 uploads/documents/<uuid>.ext
  //   qiniu 的 key = 对象 Key  documents/<yyyy-mm-dd>/<uuid>.ext
  async upload(buffer: Buffer, originalName: string, subDir = 'documents')
    : Promise<{ key: string; size: number }>;

  // 删除：local → unlink（失败静默）；qiniu → bucketManager.delete（失败只 warn，不抛出）
  async delete(key: string): Promise<void>;

  // 获取可读取的本地路径
  // local → key 本身就是绝对路径，直接返回
  // qiniu → 下载到系统临时目录，返回临时路径（调用方用完要 unlink 清理）
  async getLocalPath(key: string): Promise<string>;

  // 生成可访问的下载 URL：local → null；qiniu → `${QINIU_DOMAIN}/${key}`
  getDownloadUrl(key: string, expireSeconds = 3600): string | null;
}
```

### 切换方式

`.env` 里改一行，其余按类型补齐：
```
STORAGE_TYPE=local|qiniu
LOCAL_UPLOAD_DIR=uploads                                        # 仅 local
QINIU_ACCESS_KEY / QINIU_SECRET_KEY / QINIU_BUCKET              # 仅 qiniu，缺一即启动抛错
QINIU_REGION=z0|z1|z2|na0                                       # 默认 z0（华东）
QINIU_DOMAIN=xxx                                                # 七牛云下载必需
```

**实现方式（别搞错）**：只有一个 `StorageService` 类，`storage.module.ts` 里就是 `providers: [StorageService]`。构造函数读一次 `STORAGE_TYPE` 存进 `this.type`，之后各方法内部按 `this.type` 分支——**没有** `LocalStorageService` / `QiniuStorageService` 两个实现类。

另外七牛云下载不是一次请求：`getLocalPath()` 会依次尝试 **签名 http → 签名 https → 公开 http → 公开 https** 四个候选 URL（私有空间必须签名，而签名要求 domain 带协议前缀）。

### 使用方

| 场景 | 操作 |
|---|---|
| 文档上传 | DocumentsController → `StorageService.upload()` → 拿 `result.key` 存进 `Document.storagePath` |
| 文档处理 | DocumentProcessor → `StorageService.getLocalPath()` → qiniu 时结果存 `tempPath`，`finally` 里 unlink |
| 删除文档 | DocumentService.remove() → `StorageService.delete()` |
| 删除知识库 | KnowledgeService.remove() → 先查出所有 `document.storagePath` → 逐个 `StorageService.delete()`（失败只 warn，不阻塞 DB 删除） |

---

## 四、Workspace 模块

**文件路径**：`backend/src/workspaces/workspaces.service.ts`

### 数据模型

```typescript
model Workspace {
  id        String   @id
  ownerId   String
  name      String
  members   WorkspaceMember[]   // 协作成员
  workflows Workflow[]
  knowledgeBases WorkspaceKnowledgeBase[]
}

model WorkspaceMember {
  id          String   @id @default(uuid())
  workspaceId String
  userId      String
  createdAt   DateTime @default(now())

  @@unique([workspaceId, userId])     // ⚠️ 表里【没有 role 列】
}
```

> ⚠️ **`WorkspaceMember` 没有 `role` 字段**。接口返回的 `role: 'OWNER' | 'MEMBER'` 是 `WorkspacesService` 在查询时**现算**的：
> ```typescript
> role: m.user.id === workspace.ownerId ? 'OWNER' : 'MEMBER',
> ```
> 也就是说 **owner 一定也在 members 表里**（`create()` 时会 `members: { create: { userId } }`），role 是派生值不是存储值。
> 别去 schema 里找 `role` 字段，也别往 `workspaceMember.create()` 里传 role。

### 权限模型

| 操作 | 权限 |
|---|---|
| 查看工作空间 | owner OR member |
| 创建工作流 / 知识库 | owner OR member |
| 更新 / 删除工作空间 | **owner only** |
| 邀请成员 | owner OR member，但**被邀请人必须是已 ACCEPTED 的好友** |
| 移除成员 | **owner only**，且不能移除自己 |

**inviteMember 的校验链**（任一条不过就抛错）：
1. 邀请人是该 workspace 的 owner 或 member
2. 不能邀请自己 → `BadRequestException('不能邀请自己')`
3. `FriendshipService.getAcceptedFriendIds()` 必须包含被邀请人 → `'只能邀请已接受的好友'`
4. 不能重复加入 → `ConflictException('该用户已在 Workspace 中')`
5. 通过后**直接创建成员记录**，没有"邀请确认"流程，一步到位

> `listMembers()` / `inviteMember()` 都用 `select` 只取 `id/username/email/avatar/status`，**不会把 passwordHash 带出来**。

### assertWorkspaceMember() — 权限校验核心

几乎所有 Workflow/Knowledge/Workspace 相关的 Service 都有类似方法：
```typescript
const workspace = await this.prisma.workspace.findFirst({
  where: {
    id: workspaceId,
    OR: [{ ownerId: userId }, { members: { some: { userId } } }],
  },
  select: { id: true },
});
if (!workspace) throw new ForbiddenException('无权访问');
```

---

## 五、Dashboard 模块

**文件路径**：`backend/src/dashboard/dashboard.service.ts`

按用户 Workspace 权限过滤的 **10 个**统计接口。所有查询都先 `getUserWorkspaceIds(userId)`（owner OR member 的 workspace 列表），再以此为过滤条件。

| # | 接口 | 实际返回 |
|---|---|---|
| 1 | `GET /dashboard/overview?days=7` | `periodDays` + `workflows{ total, published, runCount, runCompleted, runFailed, runQueued, runRunning, running, successRate, avgDurationMs, p95DurationMs, failedLast24h }` + `knowledgeBases{ total, documents }` + `agents.total` + `skills.total` + `mcpServers.total` + **`tokenUsage`（真实值）** + **`modelCalls`** |
| 2 | `GET /dashboard/workflows/trend?days=7` | 按天补齐的日期序列 `[{ date, total, success, failed }]`（**空缺日期补 0**，不是只返回有数据的天） |
| 3 | `GET /dashboard/workflows/status?days=7` | `{ COMPLETED, FAILED, RUNNING, QUEUED }` 计数 |
| 4 | `GET /dashboard/nodes/performance?limit=10` | **按 nodeType 聚合的平均耗时**（近 30 天）`[{ nodeType, avgDurationMs, count, failedCount }]`，按均耗时倒序取 Top limit —— 不是"最慢的单条 NodeRun" |
| 5 | `GET /dashboard/knowledge-bases/status` | `{ total, completed, processing, failed, uploaded, completionRate }` |
| 6 | `GET /dashboard/recent-activities?limit=10` | 同时返回 `{ workflowRuns: [...], documents: [...] }`，各取 **limit 条（默认 10，不是 20）** |
| 7 | `GET /dashboard/queues/overview` | `{ waiting, active, completed, failed, delayed, oldestWaiting }` |
| 8 | `GET /dashboard/workflow-runs` | 运行记录列表 + 分页。筛选 `status` / `errorCode` / `triggerType` / `days` / `page` / `pageSize`（pageSize 上限 100）。每条附带**首个失败节点** `failedNode` / `failedNodeType` / `failedNodeError` |
| 9 | `GET /dashboard/workflow-runs/:runId` | 运行详情：概览 + `nodes[]`（节点追踪）+ `modelCalls[]`。**IO 经过 `desensitize()` 脱敏**后再返回 |
| 10 | `GET /dashboard/model-usage?days=7` | Token / 延迟 / 失败率 / 费用，含 `byModel[]` 按模型聚合 |

> ⚠️ **第 7 个接口并没有调 BullMQ 的 Queue API**。它是按 `WorkflowRun.status` 在数据库里 count 出来的（QUEUED→waiting、RUNNING→active、COMPLETED→completed、FAILED→failed），`delayed` 恒为 0。所以如果 Job 还在 Redis 里没落库，这里看不到。
>
> ✅ **更新（原文档写"tokenUsage 恒为 0"已过期）**：新增 `ModelCallLog` 表后，overview 的 `tokenUsage` 取的是 `ModelCallLog.totalTokens` 的真实聚合值，`modelCalls` 是同期的调用次数。数据由 `AiService.recordModelCall()` 在 LLM 节点执行时写入，**仅在 `workspaceId` 存在时落库**（fire-and-forget，吞异常）。
>
> ⚠️ **没有 workspaceId 的调用不记账**——Agent 聊天链路目前不写 `ModelCallLog`，所以控制台的 Token 统计只覆盖**工作流**产生的调用。
>
> `p95DurationMs` 是内存里排序取的**第 95 百分位**（`durations[Math.floor(len * 0.95)]`），不是精确 P95 算法；`durationMs` 缺失时会用 `completedAt - startedAt` 兜底。

---

## 六、Friendship 模块

**文件路径**：`backend/src/friendship/friendship.service.ts`

简单的好友关系管理，支持：发送请求 / 接受 / 拒绝 / 删除 / 列出好友 / 列出收到的请求。功能相对独立，不与其他业务模块深度耦合。

---

## 七、SSRF 防护

**文件路径**：`backend/src/workflows/engine/ssrf-check.service.ts`

HTTP 节点执行前必须过这一关（`validate(urlString)`，不通过抛 BadRequestException）：

1. **协议检查**：只允许 `http:` / `https:`，其余（`file:`、`gopher:` 等）全部拒绝
2. **主机名检查**（按 `parsed.hostname`）：
   - `localhost` / `127.0.0.1` / `::1` / `0.0.0.0`
   - 私有网段：`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、IPv6 ULA `fc00::/7`（`fc00:` / `fd00:` 开头）
   - 链路本地：`169.254.0.0/16`、IPv6 `fe80::/10`
   - 保留地址：组播 `224.0.0.0/4` 及以上（`22x`~`25x`）、运营商级 NAT `100.64.0.0/10`

工作流里的 HTTP 节点是用户可能输入 URL 的地方，如果没有 SSRF 防护，攻击者可以让服务器扫描内网。

> ⚠️ **两个已知不足**（别以为这样就万无一失）：
> 1. **没有防重定向绕过**——`axios` 默认会跟随 3xx。如果攻击者控制的公网地址 302 到 `http://127.0.0.1/...`，SSRF 检查（只验初始 URL）就绕过去了。要堵需给 axios 加 `maxRedirects: 0` 或自定义 `beforeRedirect` 再验一次。
> 2. **不解析域名**——只做字符串/正则匹配 hostname。若攻击者把自己的域名 A 记录指到 `127.0.0.1`（DNS rebinding），同样绕过。彻底防需要 `dns.lookup()` 后校验解析出的 IP。

---

## 八、RunMonitor — 运行日志

**文件路径**：`backend/src/workflows/engine/run-monitor.service.ts`

Engine.run() / runStream() 里每步都打日志：
- `logRunStart(runId, workflowId)`
- `logNodeStart(runId, nodeType, nodeId, label)`
- `logNodeComplete(runId, nodeType, nodeId, durationMs, branch)`
- `logNodeFailed(runId, nodeType, nodeId, durationMs, message)`
- `logRunComplete(runId, totalMs)`

日志输出到 console + 可选的持久化（后续可接 ELK/Loki）。runId 贯穿全链路，方便排查"某次工作流为什么失败"。
