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
  temperature      Float?       // 0.7
  
  workflowIds      String[]     // 绑定的工作流
  knowledgeBaseIds String[]     // 绑定的知识库
  skillIds         String[]     // 绑定的 Skill
  mcpServerIds     String[]     // 绑定的 MCP Server
  
  maxToolIterations Int        // ReAct 循环最大轮数（默认 10）
  temperature      Float       // 0.7

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
| update() | 只有 owner 能改；`isSystem=true` 直接拒绝 |
| remove() | 同上；系统 Agent 不可删 |

### 系统预设 Agent

应用首次启动时 `ensureSystemAgents()` 会自动创建一个名为 `"meibus"` 的默认助手：
- `isSystem=true, isDefault=true, createdBy=null`
- `model='qwen2.5:7b'`
- `systemPrompt='你是一个友好、专业的 AI 助手。直接回答用户问题即可。'`
- 不绑定任何工具 → 纯聊天

---

> 📌 **接入状态：Agent 侧的 Skill / MCP 「仅 CRUD，未接入运行时」——已确认暂缓实现，不是 bug。**
>
> `Agent.skillIds` / `Agent.mcpServerIds` 会在创建/更新时**写进数据库**（DTO 有字段、`getAvailableResources()` 也会返回可选列表），但 `AgentService` 运行时**从不读取**——它的构造函数只有 `prisma / aiService / toolRegistry / llmConfigService`，没注入 SkillService / McpService。
>
> 所以在 Agent 配置页勾选 Skill / MCP Server **不会有任何效果**，属于预留字段。
>
> **想用 Skill / MCP，请走工作流 LLM 节点**（画布上勾选），那里是真实生效的：
> - Skill → `instructions` 追加进 System Prompt
> - MCP → 转成 ToolDefinition 走 Function Calling 循环
> 详见 [05](./05-工作流引擎.md) / [08](./08-MCP-Skill-Storage-其他模块.md)。
>
> 如果将来要接，改动点是：给 `AgentModule` 导入 `SkillModule` / `McpModule`，在 `runStream()` 的初始化阶段把 `agent.skillIds` 注入 System Prompt、把 `agent.mcpServerIds` 拼进 `ToolRegistry.buildDefinitions()`。

---

## 二、runStream — ReAct 循环主流程

**文件路径**：`backend/src/agent/agent.service.ts → runStream()`

这是 Agent 的核心——一个 AsyncGenerator，边执行边 yield 事件给前端 SSE。

### 初始化阶段（非 ReAct 循环）

```
1. ensureSystemAgents() → 确保系统 Agent 存在
2. findOne(userId, agentId) → 查 Agent 记录 + 权限校验
3. 检查 agent.status !== 'DISABLED'
4. 构建 messages：
   messages = [
     { role: 'system', content: agent.systemPrompt },
     ...history,                                    // 前端传来的历史对话
     { role: 'user',   content: options.input },    // 当前用户输入
   ]
5. ToolRegistry.buildDefinitions(agent.workflowIds, agent.knowledgeBaseIds) → ToolDefinition[]
6. 持久化用户消息到 ChatMessage（如果有 sessionId），并 `chatSession.update({ updatedAt })` 把会话顶到列表最前
7. 解析 LLM Provider：
   agent.llmModelId 有值 → llmConfigService.resolveModelRuntime() → 云端 Provider
   否则 → aiService.getProvider() → 全局 Ollama 单例
8. yield { type: 'meta', agentId, agentName, model, provider }
```

### 分支 A：无工具（纯聊天）

```typescript
if (tools.length === 0) {
  // 先推一条 thinking，让前端显示"思考中"
  yield { type: 'thinking', message: '思考中...' };
  allTrailSteps.push({ type: 'thinking', message: '思考中...' });

  let fullContent = '';
  for await (const token of chatBackend.streamChat(currentMessages, chatOptions)) {
    fullContent += token;
    yield { type: 'message', content: fullContent };   // 累积内容（不是单个 token）
  }

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

  // ② LLM 直接回答（没有 tool_calls）→ 走流式输出 END
  if (result.toolCalls.length === 0) {
    // ⚠️ 注意：这里会「生成两遍答案」
    // 第一遍：把非流式 chatWithTools 已经拿到的 result.content 整段推出去（让用户立刻看到东西）
    if (result.content) {
      yield { type: 'message', content: result.content };
    }
    // 第二遍：再调一次 streamChat 重新生成，逐 token 推（打字机效果）
    // → 前端会看到"整段出现 → 内容被逐字覆盖重播"，最终落库取 streamedContent || result.content
    let streamedContent = '';
    for await (const token of chatBackend.streamChat(currentMessages, chatOptions)) {
      streamedContent += token;
      yield { type: 'message', content: streamedContent };
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

  for (const tc of result.toolCalls) {
    // 兼容 arguments 为「JSON 字符串」或「对象」两种形态（部分 OpenAI 兼容服务会返回对象）
    const args = parseToolArguments(tc.function.arguments);

    yield { type: 'tool_call', tool: tc.function.name, args };

    // ⭐ ToolRegistry 路由到具体 Tool
    //    context 里还带了 knowledgeBaseIds —— KnowledgeTool 用它确定检索范围
    const toolStart = Date.now();
    let toolResult = '';
    try {
      toolResult = await this.toolRegistry.executeTool(tc.function.name, args, {
        agentId: agent.id,
        userId,
        knowledgeBaseIds: agent.knowledgeBaseIds,   // ← 别漏，KnowledgeTool 要用
      });
    } catch (err) {
      // 工具报错不中断循环 —— 转成字符串喂回 LLM，让它自己决定怎么办
      toolResult = `工具执行错误：${err.message}`;
    }
    const durationMs = Date.now() - toolStart;

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

### 完整事件流

前端 SSE 会收到这些事件（按顺序）：

| 事件 type | 含义 | 数据 |
|---|---|---|
| `meta` | 模型信息 | agentId, agentName, model, provider |
| `thinking` | LLM 正在推理 | message |
| `tool_call` | LLM 调用工具 | tool name, args |
| `tool_result` | 工具返回结果 | tool name, result, durationMs |
| `thinking` | 继续下一轮... | |
| `message` | 最终回答（累积内容） | content（每次都是完整内容） |

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
| `content` | 消息正文 |
| `toolCalls`（Json?） | 仅 assistant：LLM 返回的原始 tool_calls，用于多轮对话历史重建 |
| `trail`（Json?） | 仅 assistant：本轮的 `thinking / tool_call / tool_result` 执行轨迹，前端渲染折叠面板 |
| `toolCallId` | 仅 tool：对应 assistant 消息里某个 toolCall 的 `id` |

**历史回放**（`ChatSessionService.getHistoryForLLM()`）：
```typescript
1. 按 createdAt 升序读出该 session 全部 ChatMessage
2. assistant 且有 toolCalls → 把 arguments 用 stringifyToolArguments() 统一成 JSON 字符串
   （历史脏数据里可能是对象，不归一化会让 Ollama 报 400）
3. tool 且有 toolCallId → 补上 tool_call_id
4. 返回 ChatMessage[]，作为 runStream 的 history 参数
```

> 两个入口的 history 处理略有差异：SSE 流式接口传**完整历史**；非流式 `POST /agents/:id/chat` 会 `history.slice(0, -1)` 去掉最后一条。
