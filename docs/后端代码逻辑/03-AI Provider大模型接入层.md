# 03 - AI Provider 大模型接入层

> 阅读本文后，你应该能回答：为什么 `AI_PROVIDER` Symbol 能变成真实的大模型调用？Provider 各自怎么发 HTTP 请求？流式和非流式怎么解析返回值？Function Calling 的数据怎么传递？模型调用监控记在哪里？

> 本文讲 **3 个 Provider 实现类**（`OllamaProvider` / `OpenAICompatibleProvider` / `DeepSeekProvider`），
> 对应 `LlmProviderType` 枚举的 **4 种类型**（`ollama` / `openai` / `deepseek` / `openai-compatible`，
> 其中 `openai` 与 `openai-compatible` 共用 `OpenAICompatibleProvider` 实现类）——「3 个实现类 / 4 种类型」。

---

## 一、设计思路：接口 + 多实现 + 工厂

```
AiProvider 接口（ai-provider.interface.ts）
    │  统一契约：chat / streamChat / chatWithTools / embedding
    │
    ├── OllamaProvider              ← 本地 Ollama（http://localhost:11434）
    ├── OpenAICompatibleProvider    ← 任何走 OpenAI /v1 协议的服务
    └── DeepSeekProvider            ← 继承 OpenAICompatible，只换默认 baseUrl

createProvider() 工厂函数（provider.factory.ts）
    │  根据 provider 类型 switch-case，手动 new 对应 Provider
    │  用于 LlmConfigService.resolveModelRuntime() 动态构造云端模型
    │
AiModule 里的 DI 绑定（ai.module.ts L10）
    │  { provide: AI_PROVIDER, useClass: OllamaProvider }
    │  应用启动时 NestJS 自动 new OllamaProvider()，注入给 AIService
```

**为什么要两层？**
- **默认场景**：AIService 用 `@Inject(AI_PROVIDER)` 拿到 DI 构造的全局 Ollama 单例——所有 Agent 共享，直接调本地 Ollama
- **自定义模型场景**：Agent 绑定了 `llmModelId` → LlmConfigService `resolveModelRuntime()` → `createProvider()` 手动 new 一个 DeepSeekProvider —— 用完即弃，每次 runStream 都是新实例

---

## 二、AiProvider 接口定义

**文件路径**：`backend/src/ai/ai-provider.interface.ts`

```typescript
export interface AiProvider {
  readonly name: string;                              // Provider 标识（日志用）
  complete(prompt: string, options): Promise<ChatResult>;            // 单轮
  chat(messages: ChatMessage[], options): Promise<ChatResult>;       // 多轮非流式
  streamChat(messages, options): AsyncGenerator<string>;            // 多轮流式
  embedding(texts, options): Promise<EmbeddingResult>;               // 向量化
  chatWithTools(messages, options, tools): Promise<ToolChatResult>;  // Function Calling
  listModels?(): Promise<string[]>;                                  // 可选：模型列表
}
```

**配套类型**：
- `ChatMessage`：`{ role: 'system'|'user'|'assistant'|'tool', content, images?, tool_calls?, tool_call_id? }`
  > `content` 的 TS 类型是 **`string`**。但云端模型可能把 `content` 返回成**多模态内容块数组**（content parts），
  > 所以 Provider 在**解析响应时**会用 `normalizeContentToString()` 归一化成字符串再往外传（见 **第九节**）。
  >
  > `images?: ChatImage[]`（`{ mimeType, base64 }`，不含 `data:` 前缀）是**视觉输入通道**——
  > 当前仅 user 消息 + 支持视觉的模型会用到：Ollama 把它挂到 `message.images`（base64 数组），
  > OpenAI 兼容 Provider 把图片转成 content parts 拼进 `messages`。
- `ChatOptions`：`{ model, temperature?, maxTokens?, telemetry? }`
  > `telemetry?: ModelCallTelemetry`（`{ workspaceId?, workflowId?, runId?, nodeRunId?, agentId? }`）
  > 是**模型调用监控上下文**——由调用方（Agent / 工作流引擎）传入，AIService 每次调用都会
  > 据此写一条 `ModelCallLog`（仪表盘 token 统计的数据源）。`workspaceId` 缺失则**不记录**。
  > 详见下文「telemetry 与 ModelCallLog」。
- `ToolDefinition`：LLM 可见的函数 schema（对齐 OpenAI 协议）
- `ToolCall`：LLM 返回的工具调用请求（`function.name` + `function.arguments` JSON 字符串）
- `ToolChatResult`：`{ content, toolCalls, model, usage }`

---

## 三、OllamaProvider 实现

**文件路径**：`backend/src/ai/providers/ollama.provider.ts`

**Endpoint**：`POST http://localhost:11434/api/chat`

### 非流式调用（chat / chatWithTools）

```typescript
fetch(`${baseUrl}/api/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'qwen2.5:7b',
    messages: this.toOllamaMessages(messages),  // ← ChatMessage[] 序列化为 Ollama 格式
    stream: false,
    tools: ToolDefinition[],                    // chatWithTools 时传
    options: this.buildOllamaOptions(options),  // ← 只传已定义的字段
  }),
})
```

> `buildOllamaOptions()` 不会无脑塞 `{ temperature: 0.7 }`：它只把 `ChatOptions` 里**已定义**的字段
> 映射过去，并把 `maxTokens` 重命名为 Ollama 的 `num_predict`（`temperature` 为空就不传）。

**Ollama 返回格式**（NDJSON → 整体一个 JSON 对象）：
```json
{
  "message": {
    "content": "你好！",
    "tool_calls": [{
      "id": "call_1",
      "type": "function",
      "function": { "name": "knowledge_search", "arguments": "{\"query\":\"年假\"}" }
    }]
  },
  "eval_count": 42,
  "prompt_eval_count": 120
}
```

**usage 的映射**：Ollama 用 `prompt_eval_count` / `eval_count` 两个字段表示 token 数，
Provider 解析时把它们映射成统一的 `usage`（`ollama.provider.ts`）：
`promptTokens = data.prompt_eval_count`、`completionTokens = data.eval_count`，
两者**都有值**时才返回 `usage`（缺失则不返回，调用方按「无用量」处理）。

### 流式调用（streamChat）

同一个 endpoint，改 `stream: true`。返回值是 **NDJSON**（每行一个独立 JSON 对象，不是 SSE）：

```
{"message":{"content":"你"}}
{"message":{"content":"好"}}
{"message":{"content":"！"}}
```

解析逻辑：
```typescript
const reader = response.body.getReader();
let buffer = '';
while (true) {
  const { done, value } = await reader.read();
  buffer += decoder.decode(value, { stream: !done });

  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';              // 最后一段可能不完整，留到下一轮

  for (const line of lines) {
    if (!line.trim()) continue;
    const data = JSON.parse(line);
    const content = data.message?.content; // ← 只取 content
    if (content) yield content;
  }
  if (done) break;                          // ← 结束靠 reader 的 done
}
```

> ⚠️ **结束信号不是 `done: true` 字段**。虽然 Ollama 每行 JSON 里确实带 `done` 字段，但本项目的解析代码**完全没有读它**——循环是靠 `reader.read()` 返回的 `done` 结束的。别照着"检测 done:true 才停"去改代码。

### 关键格式转换：toOllamaMessages()

内部统一按 OpenAI 规范存 `tool_calls.function.arguments` 为 **JSON 字符串**，但 Ollama 要求传 **对象**：

```typescript
private toOllamaMessages(messages) {
  return messages.map(m => ({
    role: m.role,
    content: m.content,
    // 如果是 assistant 消息带 tool_calls → 把 arguments 从字符串转回对象
    tool_calls: m.tool_calls?.map(tc => ({
      id: tc.id,
      type: tc.type,
      function: {
        name: tc.function.name,
        arguments: parseToolArguments(tc.function.arguments),  // ← JSON.parse
      },
    })),
    tool_call_id: m.tool_call_id,
  }));
}
```

---

## 四、OpenAICompatibleProvider 实现

**文件路径**：`backend/src/ai/providers/openai-compatible.provider.ts`

**Endpoint**：`POST {baseUrl}/chat/completions`

### 非流式调用

```typescript
fetch(`${baseUrl}/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {}),  // ← 有 key 才加（本地 Ollama 不需要）
  },
  body: JSON.stringify({
    model: 'deepseek-ai/DeepSeek-V4-Flash',
    messages: this.toOpenAIMessages(messages),
    temperature: 0.7,
    stream: false,
    tools: ToolDefinition[],
  }),
})
```

> `Authorization` 头是**条件加上**的：只有构造时传了 `apiKey` 才带。指向本地 Ollama 的
> OpenAI 兼容端点不需要鉴权，带了反而可能被拒。

**OpenAI 返回格式**：
```json
{
  "choices": [{
    "message": {
      "content": "你好！",
      "tool_calls": [{
        "id": "call_1",
        "type": "function",
        "function": { "name": "...", "arguments": "{...}" }
      }]
    }
  }],
  "usage": { "prompt_tokens": 120, "completion_tokens": 42, "total_tokens": 162 }
}
```

**usage 的读取**：OpenAI 兼容服务不一定回 `usage`（本地网关常省略）——Provider 只在
`usage.total_tokens !== undefined` 时才返回 usage，否则按「无用量」处理。

### 流式调用 —— SSE 解析

OpenAI 兼容服务用的是 SSE（Server-Sent Events），每行以 `data: ` 开头，以 `data: [DONE]` 结束：

```
data: {"choices":[{"delta":{"content":"你"}}]}
data: {"choices":[{"delta":{"content":"好"}}]}
data: [DONE]
```

解析逻辑：
```typescript
for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('data:')) continue;
  const payload = trimmed.slice(5).trim();   // 去掉 "data: " 前缀
  if (payload === '[DONE]') return;          // 结束信号
  const json = JSON.parse(payload);
  const delta = json.choices?.[0]?.delta?.content;
  if (delta) yield delta;                    // 一个 token yield 一次
}
```

### baseUrl 归一化

构造函数里有个 `normalizeBaseUrl()`：如果用户误把完整接口路径当成 baseUrl 填了（常见于复制
「聊天接口」或「模型列表」URL），会自动剥离已知后缀，保留到 API 根（含 `/v1`、`/v4` 等版本前缀）。
已知后缀有三个：`/chat/completions`、`/embeddings`、`/models`。这样后续拼接 `/chat/completions`、
`/models`、`/embeddings` 都不会重复。

---

## 五、DeepSeekProvider

**文件路径**：`backend/src/ai/providers/deepseek.provider.ts`

就一行——继承 OpenAICompatibleProvider，只换默认 baseUrl：

```typescript
export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(baseUrl, apiKey) {
    super(baseUrl || 'https://api.deepseek.com/v1', apiKey, 'deepseek');
  }
}
```

---

## 六、ProviderFactory — 动态构造

**文件路径**：`backend/src/ai/providers/provider.factory.ts`

```typescript
export function createProvider(input: ProviderConnectionInput): AiProvider {
  switch (input.provider) {
    case 'ollama':
      return new OllamaProvider(baseUrl || undefined);          // 不传 → 走默认 localhost:11434

    case 'deepseek':
      return new DeepSeekProvider(baseUrl || undefined, apiKey || undefined); // 不传 → 走类内默认

    case 'openai':
      return new OpenAICompatibleProvider(
        baseUrl || DEFAULT_BASE_URL.openai,                     // 兜底 https://api.openai.com/v1
        apiKey || undefined,
        'openai',
      );

    case 'openai-compatible':
      if (!baseUrl) throw new Error('openai-compatible 类型必须提供 baseUrl');  // ← 无默认值，必填
      return new OpenAICompatibleProvider(baseUrl, apiKey || undefined);       // name 默认 'openai-compatible'

    default:
      throw new Error(`不支持的提供商类型: ${provider}`);
  }
}
```

**默认 baseUrl 常量**（`DEFAULT_BASE_URL`）：`openai` → `https://api.openai.com/v1`、`deepseek` → `https://api.deepseek.com/v1`、`openai-compatible` → `''`（即必填）。

**调用方**：`LlmConfigService.resolveModelRuntime()` — 解密 API Key → `createProvider()` → 返回可用的
`{ provider, modelId, providerType, capabilities }`。其中 `capabilities: ModelCapability[]`（8 种能力值之一）由调用方
用来判断「这个模型支不支持流式/视觉」等，避免给不支持的能力硬发请求。

---

## 七、两种流式协议的区别

| | Ollama | OpenAI 兼容 |
|---|---|---|
| 协议 | NDJSON | SSE |
| 每行行首 | 无 | `data: ` |
| 结束信号 | **流读完（`reader.read()` 的 `done`）** —— 代码不读 `done:true` 字段 | `data: [DONE]` |
| Endpoint | `/api/chat` | `/chat/completions` |
| Arguments 格式 | 必须是 **对象** | JSON **字符串** |

Provider 层各自处理自己的协议细节，上层 AgentService 和 WorkflowEngine 完全不感知——它们只看 `yield string` 和 `ToolChatResult` 这种统一抽象。

---

## 八、Embedding 的两个细节

**① 两个 Provider 的入参字段名不同**：

| Provider | Endpoint | 请求体 |
|---|---|---|
| Ollama | `POST {baseUrl}/api/embeddings` | `{ model, prompt: text }` ← 用 `prompt` |
| OpenAI 兼容 | `POST {baseUrl}/embeddings` | `{ model, input: text }` ← 用 `input` |

**② Ollama 是一条一条发的**：`OllamaProvider.embedding()` 内部是 `for (const text of texts) { fetch(...) }`，每条文本一次 HTTP 请求。`EmbeddingService` 里的 `BATCH_SIZE = 100` 只是**外层分批**（每 100 条调一次 `provider.embedding()`），并不会减少 Ollama 的 HTTP 次数。OpenAI 兼容 Provider 同样是逐条发。

两者返回值都是 `{ embeddings: number[][], model }`。

---

## 八点五、tool-args.util — Function Calling 入参的兼容层

**文件路径**：`backend/src/ai/tool-args.util.ts`

OpenAI 规范要求 `tool_calls[].function.arguments` 是 **JSON 字符串**，但**部分 OpenAI 兼容服务
（例如经 SiliconFlow 转发的 DeepSeek）会直接返回 JSON 对象**。若下游直接 `JSON.parse(arguments)`，
遇到对象会抛 `SyntaxError: JSON.parse("[object Object]")`，参数被整体丢弃。

这个工具文件提供两个函数兜住所有形态：

| 函数 | 作用 | 行为 |
|---|---|---|
| `parseToolArguments(raw)` | 任意形态 → **对象** | `null/undefined` → `{}`；对象原样返回；JSON 字符串 parse 后返回；非 JSON 字符串 → `{ input: 字符串 }`（对以 `input` 为入参的工具友好）；其他标量 → `{ input: 值 }` |
| `stringifyToolArguments(raw)` | 任意形态 → **JSON 字符串** | `null` → `'{}'`；字符串原样；其他 `JSON.stringify`（失败回退 `'{}'`）——用于在 Provider 边界统一输出形态 |

两个 Provider 的 `chatWithTools` 都在用：**读** tool_calls 时走 `parseToolArguments`（Ollama 的
`toOllamaMessages` 也用它把字符串 arguments 转回对象），**写** history 时走 `stringifyToolArguments`。
不修这个兼容层，「经第三方转发的云端模型」的工具调用会**静默丢参数**，是最难排查的一类线上问题。

---

## 八、telemetry 与 ModelCallLog —— Provider 之上还有一层监控

**文件路径**：`backend/src/ai/ai.service.ts`（`recordModelCall` 私有方法）

AIService 在每次调用（`complete` / `chat` / `streamChat` / `chatWithTools`）的**前后**都会
调一次 `recordModelCall(telemetry, meta)` 写 `ModelCallLog`——仪表盘「Token 用量」「模型排行」
的数据来源（详见 [08](./08-MCP-Skill-Storage-其他模块.md) Dashboard 章节）。

```typescript
private async recordModelCall(
  telemetry: ModelCallTelemetry | undefined,
  meta: { model, callType, promptTokens?, completionTokens?, totalTokens?,
          latencyMs?, status, errorCode?, errorMessage?, provider? },
): Promise<void> {
  if (!telemetry?.workspaceId) return;   // ← 无归属上下文的调用一律不记录
  try {
    await this.prisma.modelCallLog.create({ data: { workspaceId: telemetry.workspaceId!, ... } });
  } catch {
    /* 监控写入失败不影响业务 */
  }
}
```

**三条硬规则**：
1. **`workspaceId` 非空才记录**——表字段是 NOT NULL，无归属上下文（如用户没进任何空间）的调用直接跳过。
2. **`meta.provider` 必须由调用方显式传入实际 Provider 名**——AIService 注入的是全局 Ollama，
   而 Agent / LLM 节点用的是 `resolveModelRuntime()` 动态构造的 Provider，不传就会把云端模型
   错误归属成 `ollama`。
3. **流式调用拿不到 usage**——`streamChat` 只记成败和延迟，Token 记 0，但调用次数正常（所以
   仪表盘按 Token 排序时要用 `calls` 兜底，否则「有调用没 Token」的模型会被挤到看不见）。

调用点（新增 Provider 调用路径时必须同步补记录）：工作流 `llm.executor` 三路、`AgentService.runStream`
多轮、`EmbeddingService.embedBatch`（EMBEDDING）。错误分类（`SUCCESS` / `FAILED` / `errorCode`）也在这一层完成。

---

## 九、内容归一化 —— 为什么 `content` 最终一定是字符串

**文件路径**：`backend/src/ai/content.util.ts`

### 背景：OpenAI 规范的 `content` 不只可能是字符串

`choices[].message.content` 有两种形态：

- **字符串**（绝大多数对话模型）：`"你好！"`
- **多模态内容块数组**（content parts，图像生成 / 多模态模型）：

```json
[{ "url": "https://…/xxx.png?Signature=…" }]
[{ "type": "image_url", "image_url": { "url": "https://…" } }]
[{ "type": "text", "text": "…" }, { "type": "image_url", "image_url": { "url": "…" } }]
```

而本项目的 `ChatMessage.content`（TS 接口）和数据库 `ChatMessage.content`（Prisma `String` 列）都要求字符串。
Provider 里若写 `content: msg?.content ?? ''`，类型标注是 `string`、运行时却原样透传了数组，
最终落库就会抛：

```
Argument `content`: Invalid value provided. Expected String, provided Object.
```

### 解决：在 Provider 边界统一归一化

`normalizeContentToString(content: unknown): string` 处理所有形态：

| 输入 | 输出 |
|---|---|
| `null` / `undefined` | `''` |
| 字符串 | 原样 |
| 数字 / 布尔 | `String(x)` |
| 数组 | 逐块提取后 `\n` 连接（跳过空块） |
| 对象 | 单块提取 |

单块提取 `extractPart()` 的优先级：

1. 文本块 `{ type: 'text' | 'input_text' | 'output_text', text }` → 取 `text`
2. 图片块 → 取 URL：`{ url }` / `{ image_url: string }` / `{ image_url: { url } }` / `{ image: { url } }` / `{ source: { url } }`
3. 内联图片 `{ b64_json }` → 转成 `data:<mime>;base64,…`
4. 兜底：块内还嵌了一层 `content` → 递归归一化

> 图片统一输出为**纯 URL 文本**，聊天页（`white-space: pre-wrap` + `word-break: break-word`）可直接展示 / 点击。

### 调用点（Provider 边界 + 落库兜底）

| 位置 | 改了什么 |
|---|---|
| `openai-compatible.provider.ts` `chat` / `chatWithTools` | content 类型改 `unknown` 并归一化，`ToolChatResult.content` 始终是字符串 |
| `openai-compatible.provider.ts` `streamChat` | `delta.content` 也归一化 —— 否则数组 token 拼进 `fullContent` 会变成 `[object Object]` |
| `ollama.provider.ts` | 同上三处 |
| `agent.service.ts` `persistAssistantMessage` + tool_calls 分支 | 落库前再过一遍，防任何 Provider 漏网 |

> **为什么放在 Provider 边界而不是落库前**：这样 Agent 聊天和工作流 LLM 节点**同时受益**，
> 上层拿到的 `content` 天然就是字符串，不需要各自防御。
> `DeepSeekProvider` 继承 `OpenAICompatibleProvider`，一并覆盖。
