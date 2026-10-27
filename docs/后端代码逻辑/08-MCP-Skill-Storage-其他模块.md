# 08 - MCP Server + Skill + 存储 + 其他模块

> 阅读本文后，你应该能回答：MCP Server 怎么在 LLM 节点/Agent 里被调用？Skill 是什么？StorageService 怎么切换本地/七牛云？Dashboard 统计了什么？Workspace 的成员权限模型是怎样的？

---

## 一、MCP Server 模块

**目录**：`backend/src/mcp/`（已按传输 / 连接 / 工具 / 安全分层）

### 接入状态（先看这个）

| 位置 | 状态 |
|---|---|
| **工作流 LLM 节点**（画布勾选 `mcpServerIds`） | ✅ **已接入**。`createParams()` 经 `McpToolService.buildBindings()` 把工具转成 ToolDefinition，工具调用走 `McpToolService.callTool()` |
| 流式 / 画布调试运行（`executeStream()`） | ❌ 未接入。忽略 tools，见 [05](./05-工作流引擎.md) |
| **Agent 配置页**（`Agent.mcpServerIds`） | ✅ **已接入**。`AgentService.runStream()` 把选中 Server 的工具合并进 ReAct 工具集，tool_call 先查 MCP binding 再回落到内置工具 |

> 📌 **Agent 侧 Skill（`Agent.skillIds`）仍未接入运行时**——字段能存能查，但 `AgentService` 没有注入 `SkillService`。
> 也就是说：**在 Agent 配置页勾选 Skill 不会生效**，只有在画布上给 LLM 节点勾选 Skill 才会注入 System Prompt。

### 目录结构与职责

```
backend/src/mcp/
├── mcp.module.ts                  # 模块装配 + 应用关闭时释放所有 MCP 会话
├── mcp.controller.ts              # 前端入口：CRUD / 测试连接 / 刷新工具 / 工具调试调用
├── mcp.service.ts                 # 配置管理 + 凭据加密 + 业务流程编排（唯一碰 Prisma 的地方）
├── mcp-connection.service.ts      # 连接建立、协议协商、会话缓存与失效重连
├── mcp-tool.service.ts            # 工具发现、schema 转换、工具调用与结果规范化
├── mcp-url-guard.service.ts       # 目标地址安全校验（SSRF / DNS 重绑定 / 重定向）
├── transports/
│   ├── mcp-transport.interface.ts # 传输抽象：connect / listTools / callTool / close
│   ├── mcp-http.util.ts           # 受限 fetch、SSE 增量解析、JSON-RPC 响应解析
│   ├── streamable-http.transport.ts  # Streamable HTTP（2025-06-18 / 2025-03-26）
│   ├── sse.transport.ts           # 旧版 HTTP + SSE（2024-11-05）
│   └── stdio.transport.ts         # 本地子进程（换行分隔 JSON-RPC，默认关闭）
├── dto/                           # create / update / call-tool
└── types/mcp.types.ts             # JSON-RPC + MCP 协议类型、错误类型
```

| 模块 | 职责 |
|---|---|
| `McpController` | 接收前端的创建、连接测试、工具查询和调用请求 |
| `McpService` | MCP 服务配置 CRUD、凭据加解密、连接状态落库、编排调用 |
| `McpConnectionService` | 初始化连接、协议协商、会话生命周期与缓存 |
| `McpTransport`（接口） | 抽象不同传输方式的通信行为 |
| `McpToolService` | 工具发现（含分页）、参数 schema 转换、工具调用与结果处理 |
| `McpUrlGuardService` | URL / 私有 IP / 保留地址 / DNS 解析 / 重定向安全校验 |

**分层原则**：MCP 模块只负责连接标准 MCP Server、发现工具和调用工具；
普通 HTTP / REST API 一律交给工作流 HTTP 节点，不在这里重复实现。

### 数据模型

```typescript
model McpServer {
  id             String   @id
  ownerId        String
  name           String
  description    String?
  transport      String   @default("STREAMABLE_HTTP")  // "SSE" | "STREAMABLE_HTTP" | "STDIO"
  serverUrl      String?                                // 远程传输才有；STDIO 为 null
  command        String?   // STDIO：可执行文件（npx / node / uvx …）
  args           Json?     // STDIO：命令行参数数组
  envCipher      Json?     // STDIO：环境变量，✅ 加密存储（可能含 API Key）
  authType       String   @default("NONE")              // "NONE" | "API_KEY" | "BEARER_TOKEN"
  credentials    Json?    // ✅ 已加密：{ v: 2, cipher: "<iv:tag:data>" }（AES-256-GCM）
  availableTools Json?    // [{ name, description, inputSchema, ... }]，连接成功后缓存
  status         String   @default("DISCONNECTED")      // DISCONNECTED | CONNECTED | ERROR
  lastError      String?
  protocolVersion String?  // 握手协商出的协议版本，如 2025-06-18
  serverName      String?  // 服务端自报名称
  serverVersion   String?  // 服务端自报版本
  lastConnectedAt DateTime? // 最后一次成功连接时间
}
```

**四个容易记错的点**：
1. 枚举值是 **`STREAMABLE_HTTP`**，不是 "http"
2. `authType` 是 `NONE / API_KEY / BEARER_TOKEN`，不是 "bearer"/"api_key"
3. `credentials` **已改为 AES-256-GCM 加密存储**（复用 `EncryptionService`，与 LLM 模型配置同一套密钥）。
   解密逻辑兼容历史明文数据，下次更新该配置时自动重新加密。
4. `availableTools / status / lastConnectedAt` 属于平台运行状态，由「测试连接 / 刷新工具」写入，用户创建时不用填

### 认证与凭据

| authType | 请求头 |
|---|---|
| `NONE` | 不带 |
| `BEARER_TOKEN` | `Authorization: Bearer <token>` |
| `API_KEY` | `X-API-Key: <key>` |

- 凭据写入时用 `EncryptionService.encrypt()` 加密，读取时解密，**绝不返回给前端**；
- 接口只返回 `hasCredentials` + `credentialPreview`（掩码，如 `sk-a****1234`）；
- `serverUrl` 中不允许内嵌 `user:pass@`，否则会被写进日志/错误信息；
- OAuth 未实现，留待有实际服务接入需求时扩展。

### 协议实现（这是与"手写三个 POST"的关键差别）

#### Streamable HTTP（推荐，`streamable-http.transport.ts`）

```
① POST {serverUrl}  initialize            → 响应头可能带 Mcp-Session-Id；校验返回的 protocolVersion
② POST {serverUrl}  notifications/initialized（无 id，预期 202）
③ POST {serverUrl}  tools/list            → 支持 nextCursor 分页，最多 20 页
④ POST {serverUrl}  tools/call
⑤ DELETE {serverUrl}                       → 主动结束会话（best-effort）
```

- 所有请求带 `Accept: application/json, text/event-stream`；
- **响应体两种形态都要处理**：`application/json` 直接解析；`text/event-stream` 则在 SSE 流里按 id 找到目标响应后**立即停止读取**（不会因为服务端不关流而挂住）；
- initialize 之后的请求都会带 `MCP-Protocol-Version` 与 `Mcp-Session-Id`；
- 服务端返回的 `protocolVersion` 不在支持列表（2025-06-18 / 2025-03-26 / 2024-11-05）内会直接报错，不做静默降级；
- 服务端对无效会话返回 404 时，标记为「会话失效」，连接层会自动重新握手并重试一次。

#### 旧版 HTTP + SSE（`sse.transport.ts`）

与 Streamable HTTP **完全独立的实现**，不是"改个 URL 就行"：

```
① GET  {serverUrl}                 → 建立 SSE 长连接，服务端先下发 event: endpoint（POST 目标地址）
② POST {endpoint}   initialize      → 服务端只回 202
③ 从 SSE 流的 event: message 里按 id 拿到 JSON-RPC 响应
④ POST {endpoint}   notifications/initialized
⑤ POST {endpoint}   tools/list / tools/call
```

- endpoint 可能是相对路径，会基于 SSE URL 解析，并且**单独再做一次安全校验**（可能指向另一个主机）；
- 服务端反向发起的请求（server → client）目前不支持，会回 `Method not found` 避免对端挂起。

#### 本地子进程 stdio（`stdio.transport.ts`）★

用于「只提供 npm 包 / 本地可执行文件、没有 URL」的 MCP（如 `fetcher-mcp`、各种 `uvx` 工具）。
**默认关闭**，需要 `MCP_STDIO_ENABLED=true` 才开放。

```
① spawn(command, args)  → 子进程的 stdin/stdout 就是 MCP 通道
② 写 {"jsonrpc":"2.0","id":1,"method":"initialize",...}\n
③ 从 stdout 按 \n 切分，逐行 JSON.parse，按 id 匹配挂起的 Promise
④ 写 notifications/initialized（无响应）
⑤ tools/list / tools/call 同一条通道
⑥ close() → 杀进程树（Windows: taskkill /T /F；POSIX: SIGTERM → SIGKILL）
```

四个必须记住的实现细节：

| 点 | 说明 |
|---|---|
| **分帧** | MCP stdio 是**换行分隔的单行 JSON**（不是 LSP 的 Content-Length）。必须自己维护缓冲区、处理半行；stdout 里的非 JSON 日志要容忍并留痕，不能直接崩 |
| **会话 = 进程** | 进程退出即连接断开，所有挂起请求要立即 reject 并带上 stderr 尾部（`stderrSuffix()`），否则调用方会一直等到超时 |
| **环境变量白名单** | **绝不能用 `{ ...process.env }`**。后端 .env 里有 `JWT_SECRET` / `LLM_CONFIG_ENCRYPTION_KEY` / 数据库密码 / 对象存储密钥，第三方 MCP 本质是任意代码，继承就等于全给。`buildChildEnv()` 只放运行时必需项 + 代理变量，用户自定义 env 单独合并 |
| **Windows 的 .cmd** | `npx` / `uvx` / `pnpm` 在 Windows 上都是 `.cmd`，`spawn(..., {shell:false})` **执行不了**。`resolveSpawnTarget()` 按 PATH 找到真实文件：`.exe/.com` 直接跑，`.cmd/.bat` 用 `cmd.exe /d /s /c` 包一层并对每个参数转义（拒绝 CR/LF/`^`） |

安全闸门（三道，都在 `McpService`）：

1. `MCP_STDIO_ENABLED=true` —— 总开关，默认关。stdio 等于在服务器上执行任意命令，比 SSRF 严重一个量级；
2. `MCP_STDIO_ALLOWED_COMMANDS` —— 命令名白名单，默认 `npx,node,uvx,python,python3,deno,bun`，挡住 `curl` / `bash -c` / `powershell`；
3. **平台助理不能创建 stdio** —— `createPendingCredentials()` 显式拒绝，自然语言入口不给「让模型在服务器上执行命令」的能力，只能由用户在 `/mcp` 页面手配。

> 校验只在**写入时**和**每次连接前**做（`runConnectionTest` 里再查一遍），所以关掉开关后历史 stdio 配置也不会再被启动。

> ⚠️ Windows 会额外注入 `HOMEDRIVE / HOMEPATH / LOGONSERVER / SYSTEMDRIVE / SYSTEMROOT / TEMP / USERDOMAIN / USERNAME / USERPROFILE / WINDIR`，这是 Node/系统行为，不是白名单失效；它们都不含密钥。

### 与 LLMNodeExecutor / AgentService 的集成

```typescript
// 1. 取运行时配置（凭据在这里解密，仅服务端内部流转）
const servers = await this.mcpService.findRuntimeConfigs(config.mcpServerIds);

// 2. 转成 ToolDefinition + 路由表（优先复用 availableTools 缓存，无缓存才实时发现）
const { tools, bindings } = await this.mcpToolService.buildBindings(servers);

// 3. 模型返回 tool_calls 后，按 binding 路由执行（会话由连接层复用，失败自动重连一次）
const outcome = await this.mcpToolService.callTool(bindings.get(name), args);
currentMessages.push({ role: 'tool', content: outcome.text, tool_call_id: id });
```

- **不做「所有 MCP 工具无差别塞给每一次模型调用」**：只加载当前 Agent / LLM 节点勾选的 Server 的工具；
- 工具重名时保留先注册的那个并打 warn 日志（MCP 工具名的全局唯一性无法保证）；
- `McpToolService.formatResult()` 统一处理 `content`（text / image / resource）、`structuredContent`、`isError`：
  优先取 text 块，没有文本时回退 `structuredContent` 的 JSON，`isError` 时加「工具返回错误：」前缀。

### 会话缓存

`McpConnectionService` 按 `transport | serverId | 配置指纹` 缓存会话（TTL 10 分钟，上限 50 条）：

- Streamable HTTP 的 `Mcp-Session-Id`、SSE 的长连接都是有状态的，缓存避免每次工具调用都重新握手；
- 同一 Server 并发调用会做**握手去重**（只发一次 initialize）；
- 配置变更（URL / transport / 认证 / 凭据）会重置 `status / availableTools / lastConnectedAt` 并让旧会话失效；
- 会话失效（404）时 `withConnection()` 会自动重连重试一次。

### 安全：SSRF / DNS 重绑定 / 重定向

`McpUrlGuardService` 比工作流 HTTP 节点的 `SsrfCheckService` 更严格：

1. 协议白名单（http / https），拒绝 `file:` / `gopher:` 等；
2. 拒绝 URL 内嵌认证信息；
3. 主机名黑名单（`localhost`、`*.local`、`*.internal`、`metadata.google.internal` 等）；
4. IP 字面量 + **DNS 解析结果**都要过私网/保留地址检查
   （`10/8`、`172.16/12`、`192.168/16`、`127/8`、`169.254/16`、`100.64/10`、组播/保留段、
   IPv6 `::1`、`fc00::/7`、`fe80::/10`、`ff00::/8`、IPv4-mapped、NAT64、6to4、Teredo），
   从而防住「域名 A 记录指向 127.0.0.1」的 DNS 重绑定；
5. 传输层 `redirect: 'manual'`，**3xx 一律报错不跟随**；
6. 单请求超时 30s、响应体上限 4MB，超出即中断。

> 校验时机：创建/更新配置时做同步形态校验（快速失败）；真正连接时做完整校验（含 DNS）。

### 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/mcp-servers` | 创建 |
| GET | `/mcp-servers` | 列表（含状态 / 工具数 / 协议版本 / 凭据掩码） |
| GET | `/mcp-servers/:id` | 详情 |
| PUT | `/mcp-servers/:id` | 更新（连接相关字段变更会重置连接状态） |
| DELETE | `/mcp-servers/:id` | 删除（同时释放会话） |
| POST | `/mcp-servers/:id/test` | 测试连接：握手 + tools/list，结果落库 |
| POST | `/mcp-servers/:id/tools/refresh` | 刷新工具列表（重新握手并覆盖缓存） |
| GET | `/mcp-servers/:id/tools` | 实时发现工具列表（不落库） |
| POST | `/mcp-servers/:id/tools/call` | 调试用：直接调用某个工具 |

`test` / `refresh` 返回 `{ success, status, transport, protocolVersion, serverInfo, instructions, tools, lastConnectedAt, message }`；
失败不抛异常，而是 `success:false + message`，前端可直接展示错误详情。

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

> 📌 **Agent 侧 Skill 仅 CRUD，未接入运行时——已确认暂缓实现，不是 bug**。
> `Agent.skillIds` 字段存在且能存能查，但 `AgentService` **没有注入 SkillService**，运行时从不读取。
> 也就是说：**在 Agent 配置页勾选 Skill 不会生效**，只有在画布上给 LLM 节点勾选 Skill 才会注入。
> （对比：`Agent.mcpServerIds` **已接入运行时**，见本文第一节。）

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

  // 读取对象存储二进制：local → 直读文件；qiniu → 下载到临时文件读 Buffer（用完需清理）
  // 被 chat-files 的 /raw 与 /download、平台工具 attach_document_to_knowledge_base 使用
  async readBuffer(key: string): Promise<Buffer>;

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
> ⚠️ **没有 workspaceId 的调用不记账**——Agent 聊天链路通过 `recordAgentCall()` 写 `ModelCallLog`
> （见 [04](./04-Agent智能体模块.md) 遥测归属一节），所以控制台的 Token 统计**同时覆盖工作流与 Agent 聊天**；
> 但无归属空间（如用户没进任何空间）的调用仍会被跳过。
>
> `p95DurationMs` 是内存里排序取的**第 95 百分位**（`durations[Math.floor(len * 0.95)]`），不是精确 P95 算法；`durationMs` 缺失时会用 `completedAt - startedAt` 兜底。

---

## 六、Friendship 模块

**文件路径**：`backend/src/friendship/friendship.service.ts`

简单的好友关系管理，支持：发送请求 / 接受 / 拒绝 / 删除 / 列出好友 / 列出收到的请求。功能相对独立，不与其他业务模块深度耦合。另含 `searchUsers(userId, keyword)`——按关键词搜索用户，是「添加好友」页的用户搜索入口。

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
>
> ✅ **MCP 侧没有这两个缺口**：`McpUrlGuardService` 会做 DNS 解析后校验每个 IP，且传输层用 `redirect: 'manual'` 拒绝跟随任何 3xx（详见本文第一节「安全」）。
> 但工作流 HTTP 节点仍然走上面这个旧实现——两者是独立的两套校验，改一处不会影响另一处。

---

## 八、RunMonitor — 运行日志

**文件路径**：`backend/src/workflows/engine/run-monitor.service.ts`

Engine.run() / runStream() 里每步都打日志：
- `logRunStart(runId, workflowId)`
- `logNodeStart(runId, nodeType, nodeId, label)`
- `logNodeComplete(runId, nodeType, nodeId, durationMs, branch)`
- `logNodeFailed(runId, nodeType, nodeId, durationMs, message)`
- `logRunComplete(runId, durationMs)`

日志输出到 console + 可选的持久化（后续可接 ELK/Loki）。runId 贯穿全链路，方便排查"某次工作流为什么失败"。
