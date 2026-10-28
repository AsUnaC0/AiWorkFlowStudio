# 04 - Agent 智能体模块

> 阅读本文后，你应该能回答：Agent 的 CRUD 是怎么做的？ReAct 循环每一轮发生什么？工具注册和路由机制是怎样的？chatSession 怎么持久化对话？

---

## 一、Agent CRUD

**文件路径**：`backend/src/agent/agent.service.ts`

### Agent 数据模型（Prisma）

```typescript
model Agent {
  id               String   @id
  workspaceId      String?
  createdBy        String?      // null = 系统预设 Agent（isDefault=true）
  name             String
  description      String?
  avatar           String?
  type             AgentType    // GENERAL | KNOWLEDGE | WORKFLOW | TOOL | CUSTOM
  isDefault        Boolean      // 系统默认助手（isDefault=true, isSystem=true）
  isSystem         Boolean      // 系统预设，不可修改
  status           AgentStatus  // DRAFT | PUBLISHED | DISABLED
  
  model            String       // 模型名（默认 qwen2.5:7b）
  llmModelId       String?      // 可选的自定义云端模型 id（优先于 model）
  systemPrompt     String?      // 给 LLM 的 System Prompt

  workflowIds      String[]     // 绑定的工作流
  knowledgeBaseIds String[]     // 绑定的知识库
  skillIds         String[]     // 绑定的 Skill
  mcpServerIds     String[]     // 绑定的 MCP Server

  maxToolIterations Int        // ReAct 循环最大轮数（默认 10）
  temperature      Float       // 0.7（schema 里是 @default(0.7)，非空）

  /** 是否允许调用 generate_file 生成 Word / Excel / PDF 文件（默认 true） */
  enableFileGeneration Boolean @default(true)
}
```

### 创建流程

1. 检查用户是否已有 workspace → 没有就关联第一个
2. 解析模型名：`llmModelId` 有值 → 查 LlmModel 表拿到真实模型标识（如 `deepseek-ai/DeepSeek-V4-Flash`）；否则回退 `dto.model` 或默认 `qwen2.5:7b`
3. 按 `dto.type` 查 USER_TEMPLATES 拿到默认的 name/description/systemPrompt
4. Prisma `agent.create({ data: {...} })`

### 权限模型

| 场景 | 规则 |
|---|---|
| list() | 返回所有 `isSystem=true` + 自己创建的 `createdBy=userId` |
| findOne() | 系统 Agent 对所有人可见；非系统 Agent 只有 owner 能访问 |
| update() | 非系统 Agent 只有 owner 能改；系统 Agent **只放开模型配置**（`llmModelId` / `model` / `temperature`，白名单见 `SYSTEM_AGENT_EDITABLE_FIELDS`），带其他字段即 400 |
| remove() | 只有 owner 能删；系统 Agent 一律不可删 |

> 系统 Agent 的 `createdBy` 为 null，所以模型配置的修改不做归属校验 ——
> 谁改谁负责，改完对所有用户生效（`llmModelId` 有值时优先于「按用户默认对话模型解析」）。

### 系统预设 Agent —— 现在只有「平台助理」一个

`ensureSystemAgents()` 已经不再自己创建助手，而是一行委托给平台助理服务（`agent.service.ts:199`）：

```typescript
async ensureSystemAgents() {
  await this.platformAssistant.ensure();   // 创建 / 迁移 / 升级都由它负责
}
```

也就是说**系统预设 Agent 有且只有一个，就是「平台助理」**：

- 识别判据是 `isSystem=true && isDefault=true`（**不是名字**，名字可以被改）
- 专属 System Prompt 由 `PlatformAssistantService.buildSystemPrompt()` 动态生成
- 工具不是绑定的资源，而是**一整套平台工具**（19 个）
- 默认不绑定固定模型（`llmModelId` 为 null），运行时按每个用户各自的默认对话模型解析；
  用户可在 Agent 配置页手动指定模型，此时 `llmModelId` 有值，运行时优先按它解析（对该实例下所有用户生效）

> 📌 **完整契约见 [11 - 平台助理](./11-平台助理.md)**：初始化与历史迁移（旧的 `meibus` 记录会**原地升级**，id 和会话历史都保留）、
> 动态上下文注入、19 个工具清单、审计表 `PlatformOperationLog`、前端操作卡片。
> 本文只讲它与 `runStream` 的衔接点。

> ⚠️ **早期文档里写的「自动创建一个名为 `meibus` 的默认助手」已过时**：
> `meibus` 只是升级前的历史名字，`ensure()` 会把这类遗留记录就地升级成平台助理，不会新建。

---

> 📌 **接入状态（2026-10-14 核对）：MCP 已接入，Skill 仍是预留字段。**
>
> | 字段 | 运行时是否生效 | 说明 |
> |---|---|---|
> | `Agent.mcpServerIds` | ✅ **已接入** | `runStream()` 初始化阶段调 `McpService.findRuntimeConfigs()` + `McpToolService.buildBindings()`（`agent.service.ts:580-593`），把选中 Server 的工具合并进 ReAct 工具集；tool_call 先查 MCP binding，没命中才回落 `ToolRegistry`（三级路由在 `:827-860`） |
> | `Agent.skillIds` | ❌ **仅 CRUD** | 字段能存能查（`getAvailableResources()` 会返回可选列表），但 `AgentService` 没有注入 `SkillService`，运行时不把 `instructions` 拼进 System Prompt。**已由产品确认暂缓实现，不是 bug** |
>
> 所以：**在 Agent 配置页勾选 MCP Server 会生效；勾选 Skill 不会。** 想用 Skill 只能走工作流的 LLM 节点（画布上勾选），详见 [05](./05-工作流引擎.md)。
>
> 如果将来要接 Skill，改动点是：给 `AgentModule` 导入 `SkillModule`，在 `runStream()` 的初始化阶段把 `agent.skillIds` 查出的 `instructions` 追加到 System Prompt。

---

## 二、runStream — ReAct 循环主流程

**文件路径**：`backend/src/agent/agent.service.ts → runStream()`

这是 Agent 的核心——一个 AsyncGenerator，边执行边 yield 事件给前端 SSE。

### 初始化阶段（非 ReAct 循环）

```
1. ensureSystemAgents() → 确保系统 Agent（平台助理）存在（委托 PlatformAssistantService.ensure()）
2. findOne(userId, agentId) → 查 Agent 记录 + 权限校验；检查 agent.status !== 'DISABLED'
3. 解析运行时 Provider：
   agent.llmModelId 有值        → llmConfigService.resolveModelRuntime()          → 云端 Provider
   平台助理（llmModelId 为 null）→ llmConfigService.resolveUserDefaultChatModel(userId) → 该用户各自的默认对话模型
   都没命中                      → aiService.getProvider()                        → 全局 Ollama 单例
   （同时记录 `supportsStream = runtime.capabilities.includes('STREAM')` —— 不支持流式的模型后面走非流式分支，避免触发服务商 SSE 限制）
4. 平台助理上下文（仅平台助理走这一步）：
   isPlatformAssistant = agent.isSystem && agent.isDefault
   assistantContext    = platformAssistant.buildContext(userId, options.workspaceId)  // workspaceId 后端重新校验成员关系
   platformToolContext = platformAssistant.buildToolContext(...)                      // userId 只来自已验证的 JWT
4.5. 遥测归属（紧跟平台助理上下文之后、附件处理之前）：
   telemetryWorkspaceId = resolveTelemetryWorkspaceId(userId, 五级回退，见下方说明)
   telemetry = telemetryWorkspaceId ? { workspaceId, agentId } : undefined
5. 处理附件（options.attachmentIds 非空时，见 10）：
   attachments = chatFiles.resolveForChat(userId, attachmentIds, sessionId)  // 校验归属 + 等 READY
   ctx = fileContext.build({ question, attachments, model, userId })         // 文本截断 + 图片转 base64
   currentUserContent = ctx.text || options.input
   currentUserImages  = ctx.images            // 仅视觉模型
6. 构建 messages：
   systemPrompt = assistantContext
     ? platformAssistant.buildSystemPrompt(assistantContext)   // 平台助理：身份规则 + 服务端注入的动态上下文
     : agent.systemPrompt                                      // 普通 Agent：库里存的静态 Prompt
   messages = [
     { role: 'system', content: systemPrompt },
     ...augmentHistoryWithAttachments(history, userId, sessionId),  // 历史消息的附件上下文重新注入
     { role: 'user', content: currentUserContent, images: currentUserImages },
   ]
7. 拼装工具集（三段，按顺序 push 进同一个 tools 数组）：
   ① 资源工具   = ToolRegistry.buildDefinitions(workflowIds, knowledgeBaseIds, { enableFileGeneration })
   ② 平台工具   = 仅平台助理：platformAssistant.buildToolDefinitions()（19 个）
   ③ MCP 工具   = 仅当 agent.mcpServerIds 非空：mcpService.findRuntimeConfigs() → mcpToolService.buildBindings()
8. 持久化用户消息到 ChatMessage（如果有 sessionId，content = 原始 options.input），并 `chatSession.update({ updatedAt })` 把会话顶到列表最前
   若有 attachmentIds → chatFiles.attachToMessage(userId, ids, messageId, sessionId) 把附件关联到这条消息
9. yield { type: 'meta', agentId, agentName, model, provider, isPlatformAssistant }
```

**工具路由优先级**（ReAct 循环里 `tool_calls` 来了之后）：

```
① 平台工具（platformToolContext 存在 && platformAssistant.isPlatformTool）→ platformAssistant.executeTool()  // 权限校验 + 审计 + 异常兜底
② MCP 工具（mcpBindings.get(name) 命中）                    → mcpToolService.callTool()
③ 资源工具（兜底）                                          → toolRegistry.executeTool()
```

> 注意平台工具的条件是 **`platformToolContext && isPlatformTool(name)`** 两段都满足——
> 只有平台助理才拿得到 `platformToolContext`，普通 Agent 即使猜到了平台工具的名字也不会走到这一支。

> **平台助理的三点特别之处**（详见 [11](./11-平台助理.md)）：
> 1. **不绑定固定模型** —— 一份记录服务所有用户，所以 `llmModelId` 为 null，靠第 3 步按用户解析
> 2. **System Prompt 是动态生成的** —— 库里存的 `systemPrompt` 会被覆盖
> 3. **工具来自后端注册，不是用户配置** —— 19 个平台工具，用户无法通过聊天临时定义

> **附件解析失败**：用户消息已落库（不丢），但本轮会 `yield { type: 'error', message }` 直接结束，不再调用 LLM。
>
> **遥测归属（ModelCallLog）**：初始化第 9 步解析 `telemetryWorkspaceId` 后构造
> `telemetry = { workspaceId, agentId }`，之后每次 LLM 调用前后都 `recordAgentCall(telemetry, chatBackend, {...})`
> 写 `ModelCallLog`（成功/失败都记）。`workspaceId` 的解析是**五级回退链**
> （`resolveTelemetryWorkspaceId()`，`agent.service.ts:928`）：
> 1. 平台助理当前选中的空间
> 2. 平台助理可访问的第一个空间（多空间且未选择时兜底，保证统计不丢）
> 3. Agent 自身所属空间（普通 Agent）
> 4. 前端传入的 `workspaceId`（仅作意图，最后才用）
> 5. 用户最早创建的可见空间（纯个人对话兜底）
>
> `telemetry` 还会**往下传给工具**（`ToolRegistry.executeTool` 的 context）——工具内部若再发起模型调用
> （工作流 LLM 节点、知识库向量化）才能被归入统计。
>
> 附件上下文注入的完整逻辑（解析器分派、预算截断、视觉通道、越权防护）见 **[10 - 聊天文件上传模块](./10-聊天文件上传模块.md)**。

### 分支 A：无工具（纯聊天）

```typescript
if (tools.length === 0) {
  // 先推一条 thinking，让前端显示"思考中"
  yield { type: 'thinking', message: '思考中...' };
  allTrailSteps.push({ type: 'thinking', message: '思考中...' });

  let fullContent = '';
  if (supportsStream) {
    for await (const token of chatBackend.streamChat(currentMessages, chatOptions)) {
      fullContent += token;
      yield { type: 'message', content: fullContent };   // 累积内容（不是单个 token）
    }
  } else {
    // 模型不支持流式：改用一次性非流式 chat，避免触发服务商 SSE 限制（如 1212 错误）
    const res = await chatBackend.chat(currentMessages, chatOptions);
    fullContent = res.content;
    yield { type: 'message', content: fullContent };
  }
  // 前后各调一次 recordAgentCall(telemetry, ...) 写 ModelCallLog（成功/失败都记，见 03 第八节）

  // 落库 assistant 消息（content + trail 执行轨迹），再刷一次 updatedAt
  return;
}
```

> `allTrailSteps` 是本轮累积的 `thinking / tool_call / tool_result` 数组，最终会写进 ChatMessage 的 **`trail`** 字段，供前端渲染"执行轨迹"折叠面板。

### 分支 B：有工具 → ReAct 循环

```typescript
for (let i = 0; i < maxIters; i++) {
  yield { type: 'thinking', message: `思考中... (第 ${i + 1} 轮)` };

  // ① 调 LLM（非流式，因为要等完整的 tool_calls 才能决策）
  const result = await chatBackend.chatWithTools(currentMessages, chatOptions, tools);

  // ② LLM 直接回答（没有 tool_calls）→ 分块推出去做打字机效果 END
  if (result.toolCalls.length === 0) {
    // chatWithTools 拿到的 content 已经是完整答案，直接切片推送即可。
    // ⚠️ 早期实现是「先推整段 content，再调一次 streamChat 重新生成一遍」，
    //    代价很大，已废弃，详见下面「为什么不再二次调用」。
    if (result.content) {
      yield* streamAsTypewriter(result.content);   // 每 3 字一片，整段约 600ms 打完
    } else if (supportsStream) {
      // 兜底：模型给了空回答（拒绝/异常）才退回真流式再试一次
      for await (const token of chatBackend.streamChat(currentMessages, chatOptions)) {
        streamedContent += token;
        yield { type: 'message', content: streamedContent };
      }
    }
    // 落库 + END
    return;
  }

  // ③ LLM 要调工具 → 逐个执行
  currentMessages.push({                              // 把 assistant 的 tool_calls 追加到上下文
    role: 'assistant',
    content: result.content,
    tool_calls: result.toolCalls,
  });

  // 会话模式下：assistant 的 tool_calls 也会单独落库一条 ChatMessage（role=assistant，带 toolCalls）
  // 这样下次读历史时能完整重建「assistant 发起了哪些 tool_call」的链路
  if (options.sessionId) {
    await this.prisma.chatMessage.create({
      data: {
        sessionId: options.sessionId,
        role: 'assistant',
        content: normalizeContentToString(result.content),
        toolCalls: result.toolCalls as any,
      },
    });
  }

  for (const tc of result.toolCalls) {
    // 兼容 arguments 为「JSON 字符串」或「对象」两种形态（部分 OpenAI 兼容服务会返回对象）
    const args = parseToolArguments(tc.function.arguments);

    yield { type: 'tool_call', tool: tc.function.name, args };

    // ⭐ 三级路由：平台工具 → MCP 工具 → 资源工具（ToolRegistry）
    //    context 里还带了 knowledgeBaseIds —— KnowledgeTool 用它确定检索范围
    const toolStart = Date.now();
    let toolResult = '';
    try {
      if (platformToolContext && this.platformAssistant.isPlatformTool(tc.function.name)) {
        // ① 平台工具：走 PlatformAssistantService，内部做权限校验 + 审计 + operation 事件
        const execution = await this.platformAssistant.executeTool(
          tc.function.name, args, platformToolContext,
        );
        toolResult = execution.text;
        if (execution.operation) yield { type: 'operation', operation: execution.operation };
      } else {
        // ② MCP 工具：按 binding 路由（会话由连接层复用，失败自动重连一次）
        const binding = mcpBindings.get(tc.function.name);
        if (binding) {
          const outcome = await this.mcpToolService.callTool(binding, args);
          toolResult = outcome.text;
        } else {
          // ③ 资源工具（workflow / knowledge / generate_file）
          toolResult = await this.toolRegistry.executeTool(tc.function.name, args, {
            agentId: agent.id,
            userId,
            knowledgeBaseIds: agent.knowledgeBaseIds,   // ← 别漏，KnowledgeTool 要用
            // 遥测往下传：工具内部若再发起模型调用（工作流 LLM 节点 / 知识库向量化）才能被统计
            telemetry,
          });
        }
      }
    } catch (err) {
      // 工具报错不中断循环 —— 转成字符串喂回 LLM，让它自己决定怎么办
      toolResult = `工具执行错误：${err.message}`;
    }
    const durationMs = Date.now() - toolStart;

    // 工具可能产出了文件（generate_file）——flushFileEvents() 在 tool_result 之前 yield，
    // 让前端先渲染文件卡片再看到工具结果
    for (const event of flushFileEvents()) {
      yield event;
    }

    yield { type: 'tool_result', tool: tc.function.name, result: toolResult, durationMs };

    // 会话模式下：tool 结果单独落库一条 role='tool' 消息（带 toolCallId）
    // 把工具结果作为 role:'tool' 的消息追加
    currentMessages.push({
      role: 'tool',
      content: toolResult,
      tool_call_id: tc.id,
    });
  }

  // 继续下一轮 → LLM 就能看到工具返回值，决定是继续调工具还是回答
}

// 超过 maxToolIterations → 报错退出
yield { type: 'error', message: 'Agent 达到最大工具调用次数限制' };
// 并且会再落库一条 assistant 消息：⚠️ Agent 达到最大工具调用次数限制（带完整 trail）
```

### 为什么不再二次调用模型（曾经的坑）

早期实现为了「让用户尽快看到东西 + 拿到真流式打字机」，做了两件事：

1. 先把 `chatWithTools` 已经拿到的 `result.content` **整段** yield 出去
2. 再调一次 `streamChat` 从头生成一遍，逐 token 覆盖

代价是三个，且都很实在：

| 问题 | 表现 |
|---|---|
| **多花一次模型调用** | 同一轮请求付两份钱、等两轮延迟。实测一轮对话从 2.8s 涨到 5.9s |
| **两次生成内容不一致** | `temperature > 0` 时不保证复现。用户会看到气泡里的字**突变**成另一段话 |
| **长度回退** | 第二次是从 `streamedContent = ''` 累积，前端按「累积覆盖」渲染就会看到字数从 102 掉回 1，桌宠客户端踩过：气泡先显示一段完整介绍，几秒后被换成一句更短的招呼 |

现在改成 `streamAsTypewriter(result.content)`：对已有答案切 3 字一片推送，
按总长度反推间隔让整段约 600ms 打完。效果和真流式看不出差别，
但只调一次模型、内容唯一、首字延迟从 6.6s 降到 2.8s。

> 保留的兜底：`result.content` 为空（模型拒绝 / 异常）时才退回 `streamChat` 再试一次，
> 否则会「模型什么都没说，用户也什么都没看到」。

### 完整事件流

前端 SSE 会收到这些事件（按顺序）：

| 事件 type | 含义 | 数据 |
|---|---|---|
| `meta` | 模型信息 | agentId, agentName, model, provider, **isPlatformAssistant** |
| `thinking` | LLM 正在推理 | message |
| `tool_call` | LLM 调用工具 | tool name, args |
| **`file`** | **`generate_file` 产出的文件**（每个工具执行后，`flushFileEvents()` 在 `tool_result` **之前** yield） | file，前端渲染成文件卡片，见 09 |
| **`operation`** | **平台工具的一次操作记录**（仅平台助理） | operation（工具 / 风险 / 目标资源 / 状态 / 耗时 / 跳转链接），前端渲染成操作卡片，见 11 |
| `tool_result` | 工具返回结果 | tool name, result, durationMs |
| `thinking` | 继续下一轮... | |
| `message` | 最终回答（累积内容） | content（每次都是完整内容） |
| `error` | 出错（附件解析失败 / 达到工具调用上限 / Agent 被禁用） | message |

---

## 三、ToolRegistry — 工具注册中心

**文件路径**：`backend/src/agent/tool-registry.service.ts`

### buildDefinitions() — 生成 LLM 可见的 ToolDefinition

```typescript
async buildDefinitions(
  workflowIds: string[],
  knowledgeBaseIds: string[],
  options: { enableFileGeneration?: boolean } = {},
): Promise<ToolDefinition[]> {
  const workflowDefs = await this.workflowTool.buildDefinitions(workflowIds);
  const knowledgeDefs = await this.knowledgeTool.buildDefinitions(knowledgeBaseIds);

  const defs: ToolDefinition[] = [...workflowDefs, ...knowledgeDefs];
  if (options.enableFileGeneration !== false) {
    defs.push(this.generateFileTool.buildDefinition());   // 内置能力
  }
  return defs;
}
```

> `generate_file` 是**内置工具**，不依赖任何绑定资源，只由 `Agent.enableFileGeneration`（默认 `true`）开关。调用方传的是 `{ enableFileGeneration: agent.enableFileGeneration !== false }`。

### executeTool() — 路由执行

```typescript
async executeTool(toolName: string, args, context) {
  // 按前缀匹配
  const workflowMatch = toolName.match(/^workflow_([0-9a-f-]{36})$/i);
  if (workflowMatch) {
    return this.workflowTool.execute(args, { ...context, workflowId: workflowMatch[1] });
  }

  if (toolName === 'knowledge_search') {
    return this.knowledgeTool.execute(args, context);
  }

  if (toolName === GENERATE_FILE_TOOL_NAME) {   // 'generate_file'
    return this.generateFileTool.execute(args, context);
  }

  throw new Error(`未知工具: ${toolName}`);
}
```

**路由规则**：
| tool name | 路由到 | 用途 |
|---|---|---|
| `workflow_{uuid}` | WorkflowTool | 执行绑定的工作流 |
| `knowledge_search` | KnowledgeTool | 在绑定的知识库中搜索 |
| `generate_file` | GenerateFileTool | 生成 Word / Excel / PDF / Markdown / CSV 文件 |

---

## 三·五、GenerateFileTool — 文件生成工具

**文件路径**：`backend/src/agent/tools/generate-file.tool.ts`

**唯一必填参数**是 `format`（枚举 `docx / xlsx / pdf / md / csv`），其余按类型选填：
- 文档类：`markdown`（推荐）或 `blocks`
- 表格类：`sheets`（可多工作表）或 `columns` + `rows`

执行成功后：

```typescript
context.files?.push(file);   // 回传给 AgentService → 推 SSE file 事件 + 关联消息
```

**失败不抛异常**，而是返回一段提示文本让模型自己修正参数后重试（"请检查参数（format 是否支持、内容是否为空）"），这样 ReAct 循环不会因为一次参数错误就整体崩掉。

> 完整的生成 / 存储 / 预览 / Word 兼容性逻辑见 **[09 - 文件生成模块](./09-文件生成模块.md)**。

---

## 四、WorkflowTool — 工作流工具

**文件路径**：`backend/src/agent/tools/workflow.tool.ts`

### buildDefinitions()

只查 `status: 'PUBLISHED'` 的工作流，**每个**生成一个 ToolDefinition：

```typescript
{
  type: 'function',
  function: {
    name: `workflow_${wf.id}`,
    // description 是拼出来的，不是裸的 workflow.description：
    //   `调用工作流「${wf.name}」（已发布 v${version}）。用途：${wf.description}`
    //   （description 为空则省略「用途」那半句）
    description: `调用工作流「xxx」（已发布 v3）。用途：xxx`,
    parameters: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: '传给工作流的输入内容（自然语言 / JSON 字符串都可）',
        },
      },
      required: ['input'],          // ← input 是必填的，不是空 properties
    },
  },
}
```

### execute()

1. 从 `context.workflowId`（由 ToolRegistry 从函数名里正则解析出来）读工作流
2. 校验：`status === 'PUBLISHED'`、必须有 `publishedVersion`，否则抛错
   > **只读 publishedVersion，不碰 currentVersion** —— 保证 Agent 调的是稳定版本，用户改草稿不影响
3. `extractInput(args)` 提取输入，兼容四种形态：
   - `{ input: "..." }` ← 标准
   - `{ raw: { input: "..." } }` ← 历史兜底包裹
   - `{ raw: "..." }`
   - 其他未知字段 → 整体 JSON 化作为输入
4. `engine.run(publishedVersion.definition, input)` （**同步非流式**，不带 runId，不落 NodeRun）
5. 输出取值：`typeof result.previousOutput === 'string' ? previousOutput : JSON.stringify(previousOutput ?? result.data)`
6. 返回 `工作流「名称」(vN) 运行结果：\n${output}`

---

## 五、KnowledgeTool — 知识库搜索工具

**文件路径**：`backend/src/agent/tools/knowledge.tool.ts`

### buildDefinitions()

不管绑定了多少个知识库，**只生成一个**综合工具 `knowledge_search`（三个参数，不是只有 query）：

```typescript
{
  type: 'function',
  function: {
    name: 'knowledge_search',
    // description 里会注入可用知识库清单，让 LLM 知道该选哪个：
    //   从绑定的知识库中检索相关信息。
    //   可用知识库：
    //   - abcd1234 (产品手册)：产品介绍文档
    //   LLM 可以通过 knowledgeBaseIds 参数指定检索范围；留空则全部检索。
    description: '从绑定的知识库中检索相关信息。\n可用知识库：\n- abcd1234 (产品手册)…',
    parameters: {
      type: 'object',
      properties: {
        query:             { type: 'string', description: '检索查询（自然语言）' },
        knowledgeBaseIds:  { type: 'array', items: { type: 'string' },
                             description: '指定要检索的知识库 ID 列表（ID 前 8 位即可）；留空则全部检索' },
        topK:              { type: 'integer', description: '返回 Top N 条结果，默认 5' },
      },
      required: ['query'],     // ← 只有 query 必填
    },
  },
}
```

### execute()

1. `query` 为空 → 直接返回 `'错误：query 不能为空'`
2. **解析知识库范围**：LLM 传的 `args.knowledgeBaseIds` 可以是**前 8 位缩写**，用 `boundId.startsWith(short)` 匹配回完整 UUID；没传就用 Agent 绑定的全部（`context.knowledgeBaseIds`）
3. `KnowledgeRetrievalService.search({ knowledgeBaseIds, query, topK, mode: 'hybrid' })` —— **固定 hybrid 模式**
4. 无命中 → 返回 `知识库中未检索到与「xxx」相关的内容。`
5. 有命中 → 拼成 `检索到 N 条结果：\n\n[1] (来源：文件名) 相似度=0.912\n内容…`

---

## 六、AgentTool 接口

**文件路径**：`backend/src/agent/tools/agent-tool.interface.ts`

```typescript
export interface AgentTool {
  readonly definition: ToolDefinition;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<string>;
}
```

> 注意：WorkflowTool 和 KnowledgeTool 并没有直接 `implements AgentTool`——因为它们的 `definition` 依赖运行时动态数据（workflowIds、knowledgeBaseIds），所以用了 `buildDefinitions()` 的替代模式，而不是在构造时固定 `readonly definition`。

**设计意图**：ReAct 循环里调 ToolRegistry.executeTool() → 路由到某个 Tool.execute() → 返回 `Promise<string>` → 作为 `role:'tool'` 消息喂回 LLM。所有 Tool 的返回值必须是字符串，因为 LLM 的 tool message content 就是字符串。

---

## 七、ChatSession — 对话持久化

AgentController 的 SSE 接口支持 `sessionId` 参数：
- 有 sessionId → 每轮用户消息、assistant 消息、tool 消息都落库到 ChatMessage 表
- 下次前端带同一个 sessionId → 从 ChatMessage 表读出历史，传给 AgentService.runStream() 的 `history` 参数

ChatMessage 的 role 有 4 种：`user` / `assistant` / `system` / `tool`。

| 字段 | 用途 |
|---|---|
| `role` | user / assistant / system / tool |
| `content` | 消息正文（**始终是字符串**）—— 云端模型可能把内容返回成多模态 content parts 数组，Provider 边界已用 `normalizeContentToString()` 归一化，落库前 `persistAssistantMessage()` 再兜一道，见 [03 第九节](./03-AI%20Provider大模型接入层.md) |
| `toolCalls`（Json?） | 仅 assistant：LLM 返回的原始 tool_calls，用于多轮对话历史重建 |
| `trail`（Json?） | 仅 assistant：本轮的 `thinking / tool_call / tool_result` 执行轨迹，前端渲染折叠面板 |
| `toolCallId` | 仅 tool：对应 assistant 消息里某个 toolCall 的 `id` |
| `files`（关联） | 仅 assistant：本轮 `generate_file` 产出的文件（`GeneratedFile`），渲染成文件卡片，见 09 |
| `attachments`（关联） | 仅 user：随消息上传的聊天附件（`ChatAttachment`），历史回看能看到用户当时发了哪些文件，见 10 |

**历史回放**（`ChatSessionService.getHistoryForLLM()`）：
```typescript
1. 按 createdAt 升序读出该 session 全部 ChatMessage
2. assistant 且有 toolCalls → 把 arguments 用 stringifyToolArguments() 统一成 JSON 字符串
   （历史脏数据里可能是对象，不归一化会让 Ollama 报 400）
3. tool 且有 toolCallId → 补上 tool_call_id
4. 返回 ChatMessage[]，作为 runStream 的 history 参数
```

> `getWithMessages()`（前端**读取**会话详情用）会 `include` `messages.attachments` 与 `messages.files`，所以历史消息的附件/文件卡片都能直接渲染。注意它和 `getHistoryForLLM()`（喂给**模型**用）是两条不同的查询——后者不带关联，附件内容由 `augmentHistoryWithAttachments()` 单独按预算拼接。

> 两个入口的 history 处理略有差异：SSE 流式接口传**完整历史**；非流式 `POST /agents/:id/chat` 会 `history.slice(0, -1)` 去掉最后一条。
