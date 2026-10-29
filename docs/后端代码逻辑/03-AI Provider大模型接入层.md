# 03 - AI Provider 大模型接入层

> 阅读本文后，你应该能回答：为什么 `AI_PROVIDER` Symbol 能变成真实的大模型调用？Provider 各自怎么发 HTTP 请求？流式和非流式怎么解析返回值？Function Calling 的数据怎么传递？模型调用监控记在哪里？

> 本文讲 **2 个 Provider 实现类**（`OllamaProvider` / `OpenAICompatibleProvider`），
> 对应 `LlmProviderType` 枚举的 **4 种类型**（`ollama` / `openai` / `deepseek` / `openai-compatible`，
> 其中 `openai` / `deepseek` / `openai-compatible` **三者共用 `OpenAICompatibleProvider` 实现类**，
> 只在构造参数上区分默认 baseUrl 与实例 `name`）——「2 个实现类 / 4 种类型」。
>
> 早期版本曾有一个 `DeepSeekProvider extends OpenAICompatibleProvider` 的子类，因只有 4 行有效代码、
> 与 `openai` 分支的处理方式不对称，已删除（见第五节）。

---

## 一、设计思路：接口 + 多实现 + 工厂

```
AiProvider 接口（ai-provider.interface.ts）
    │  统一契约：chat / streamChat / chatWithTools / embedding
    │
    ├── OllamaProvider              ← 本地 Ollama（http://localhost:11434）
    └── OpenAICompatibleProvider    ← 任何走 OpenAI /v1 协议的服务
                                       （openai / deepseek / openai-compatible 三种类型共用）

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
- **自定义模型场景**：Agent 绑定了 `llmModelId` → LlmConfigService `resolveModelRuntime()` → `createProvider()` 手动 new 一个 Provider 实例 —— 用完即弃，每次 runStream 都是新实例

---

## 二、AiProvider 接口定义

**文件路径**：`backend/src/ai/ai-provider.interface.ts`

```typescript
export interface AiProvider {
  readonly name: string;                              // Provider 标识（日志 / ModelCallLog 用）
  complete(prompt: string, options): Promise<ChatResult>;            // 单轮
  chat(messages: ChatMessage[], options): Promise<ChatResult>;       // 多轮非流式
  streamChat(messages, options): AsyncGenerator<ChatStreamChunk>;    // 多轮流式（正文 + 推理双通道）
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
- `ToolChatResult`：`{ content, reasoning?, toolCalls, model, usage }`
- `ChatStreamChunk`：`{ type: 'content' | 'reasoning', text }` —— 见下节

### 为什么流式要返回「分片」而不是纯字符串

思考型模型（DeepSeek reasoner / Ollama thinking 模型）在一次响应里会**同时**吐两条流：
推理过程（`reasoning_content` / `message.thinking`）和正文（`content`）。
早期 `streamChat` 直接 `AsyncGenerator<string>`，只能表达一条流，结果只有两个选择：
把推理拼进正文（污染气泡、写进聊天记录、被桌宠念出来），或者直接丢掉。

现在改成联合类型，两条通道各自独立：

```typescript
export type ChatStreamChunk =
  | { type: 'content'; text: string }     // 正文
  | { type: 'reasoning'; text: string };  // 推理过程

/** 只要正文的调用方套一层即可降级成 AsyncGenerator<string> */
export async function* contentOnly(
  source: AsyncIterable<ChatStreamChunk>,
): AsyncGenerator<string> {
  for await (const chunk of source) {
    if (chunk.type === 'content') yield chunk.text;
  }
}
```

非流式接口则是在 `ChatResult` / `ToolChatResult` 上加**可选** `reasoning?: string`——
普通模型没有推理过程时该字段直接不出现，调用方必须容忍缺失。

---

## 三、OllamaProvider 实现

**文件路径**：`backend/src/ai/providers/ollama.provider.ts`

**Endpoint**：`POST http://localhost:11434/api/chat`

### 非流式调用（chat / chatWithTools）

两个方法打同一个 endpoint，**请求体只差一个 `tools` 字段**。

`chat()`：

```typescript
fetch(`${this.baseUrl}/api/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: options.model,                       // ← 由调用方传入，Provider 不写死模型名
    // 必须走 toOllamaMessages：含 tool_calls 的历史消息需要把 arguments 转回对象
    messages: this.toOllamaMessages(messages),
    stream: false,
    options: this.buildOllamaOptions(options),  // ← 只传已定义的字段
  }),
})
```

`chatWithTools()`：其余完全一致，多一行 `tools`。Ollama 0.3.0+ 的 `/api/chat` 支持 tools，
且 schema 与 OpenAI 同构，**原样透传、不做任何转换**：

```typescript
  body: JSON.stringify({
    model: options.model,
    messages: this.toOllamaMessages(messages),
    stream: false,
    tools,                                      // ← ToolDefinition[]，直接传
    options: this.buildOllamaOptions(options),
  }),
```

> ⚠️ **`model` 不是写死的**。Provider 层永远只读 `options.model`，模型名完全由调用方决定，共三条来源：
>
> 1. **Agent 聊天** —— `chatModel = agent.model`（`agent.service.ts:476`）。
>    这个字段在创建 / 更新 Agent 时由 `resolveModelName()` 写入：没有 `llmModelId` 就落
>    `DEFAULT_LOCAL_MODEL = 'qwen2.5:7b'`（`agent.service.ts:113`）；有 `llmModelId` 则写入真实模型标识。
>    运行时还会被覆盖两次：绑了自定义模型 → `runtime.modelId`（`:486`）；平台助理 → 用户默认对话模型的
>    `modelName`（`:493`）。
> 2. **工作流 LLM 节点** —— `config.model ?? 'qwen2.5:7b'`（`llm.executor.ts:419`）。
> 3. **用户自建模型** —— `LlmConfigService.resolveModelRuntime()` 解出来的 `LlmModel.modelId`。
>
> 所以 `'qwen2.5:7b'` 只出现在**这些调用方的兜底默认值**里，Provider 里一次都没有。

> `buildOllamaOptions()` 不会无脑塞 `{ temperature: 0.7 }`：它只把 `ChatOptions` 里**已定义**的字段
> 映射过去，并把 `maxTokens` 重命名为 Ollama 的 `num_predict`（`temperature` 为空就不传）。

**Ollama 返回格式**（NDJSON → 整体一个 JSON 对象）：
```json
{
  "message": {
    "content": "你好！",
    "thinking": "用户只是打招呼，简短回应即可。",
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

> `thinking` 只有思考型模型（`deepseek-r1` / `qwen3` 等）才会返回，映射到 `ChatResult.reasoning`；
> 普通模型这个字段不存在，`normalizeContentToString(undefined)` 得到空串，直接不返回 `reasoning`。

**usage 的映射**：Ollama 用 `prompt_eval_count` / `eval_count` 两个字段表示 token 数，
Provider 解析时把它们映射成统一的 `usage`（`ollama.provider.ts`）：
`promptTokens = data.prompt_eval_count`、`completionTokens = data.eval_count`，
两者**都有值**时才返回 `usage`（缺失则不返回，调用方按「无用量」处理）。

### 流式调用（streamChat）

同一个 endpoint，改 `stream: true`。返回值是 **NDJSON**（每行一个独立 JSON 对象，不是 SSE）：

```
{"message":{"thinking":"先拆题："}}
{"message":{"thinking":"一打=12个。"}}
{"message":{"content":"一共 24 个。"}}
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
    // 思考型模型：message.thinking 是推理过程，走独立通道
    const thinking = normalizeContentToString(data.message?.thinking);
    if (thinking) yield { type: 'reasoning', text: thinking };

    const content = data.message?.content; // ← 正文
    if (content) yield { type: 'content', text: normalizeContentToString(content) };
  }
  if (done) break;                          // ← 结束靠 reader 的 done
}
```

> ⚠️ **结束信号不是 `done: true` 字段**。虽然 Ollama 每行 JSON 里确实带 `done` 字段，但本项目的解析代码**完全没有读它**——循环是靠 `reader.read()` 返回的 `done` 结束的。别照着"检测 done:true 才停"去改代码。
>
> ⚠️ **`thinking` 必须走 reasoning 通道**。普通模型这一行是 `undefined`，`normalizeContentToString(undefined)` 返回空串，不 yield —— 所以这段逻辑对非思考型模型零影响。

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
    model: options.model,                 // ← 由调用方传入，Provider 不写死模型名
    messages: this.toOpenAIMessages(messages),
    temperature: options.temperature,     // ← 原样透传（不传就是 undefined，交给服务端默认值）
    max_tokens: options.maxTokens,
    stream: false,
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
      "reasoning_content": "用户只是打招呼，简短回应即可。",
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

**推理过程（`reasoning_content` / `reasoning`）**：思考型模型会在 `message` 上多带一个字段。
字段名各家不统一，`pickReasoning()` 按优先级探测：

| 字段 | 谁在用 |
|---|---|
| `reasoning_content` | DeepSeek reasoner、硅基流动等，最常见 |
| `reasoning` | OpenRouter、部分自建网关 |

两者都可能是字符串或内容块数组，统一过 `normalizeContentToString()`。
都没有则**不返回 `reasoning` 字段**（不是返回空串）—— 调用方据此判断「这个模型有没有思考过程」。

**usage 的读取**：OpenAI 兼容服务不一定回 `usage`（本地网关常省略）——Provider 只在
`usage.total_tokens !== undefined` 时才返回 usage，否则按「无用量」处理。

### 流式调用 —— SSE 解析

OpenAI 兼容服务用的是 SSE（Server-Sent Events），每行以 `data: ` 开头，以 `data: [DONE]` 结束：

```
data: {"choices":[{"delta":{"reasoning_content":"用户只是"}}]}
data: {"choices":[{"delta":{"reasoning_content":"打个招呼。"}}]}
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
  const delta = json.choices?.[0]?.delta;

  // 推理增量先到，走独立通道 —— 绝不能拼进 content
  const reasoning = pickReasoning(delta);
  if (reasoning) yield { type: 'reasoning', text: reasoning };

  if (delta?.content != null) {
    yield { type: 'content', text: normalizeContentToString(delta.content) };
  }
}
```

> ⚠️ **推理增量在正文之前到达**。同一个 SSE 流里先来一串 `delta.reasoning_content`，
> 再来 `delta.content`，最后 `[DONE]`。如果把两者都 `yield` 成字符串，
> 前端会看到推理内容和答案黏在一个气泡里，而且会被 `ChatMessage.content` 一起落库。

### baseUrl 归一化

构造函数里有个 `normalizeBaseUrl()`：如果用户误把完整接口路径当成 baseUrl 填了（常见于复制
「聊天接口」或「模型列表」URL），会自动剥离已知后缀，保留到 API 根（含 `/v1`、`/v4` 等版本前缀）。
已知后缀有三个：`/chat/completions`、`/embeddings`、`/models`。这样后续拼接 `/chat/completions`、
`/models`、`/embeddings` 都不会重复。

---

## 五、为什么 DeepSeek 没有独立的 Provider 类

`LlmProviderType` 里有 `deepseek` 这个**产品级选项**（前端下拉框里要显示「DeepSeek」，
`LlmProviderConfig.provider` 里要存 `'deepseek'`），但**没有对应的实现类**——
它和 `openai`、`openai-compatible` 一样，都由 `OpenAICompatibleProvider` 承载，
区别只在工厂传进去的两个构造参数：

```typescript
new OpenAICompatibleProvider(
  baseUrl || DEFAULT_BASE_URL.deepseek,  // 默认 https://api.deepseek.com/v1
  apiKey || undefined,
  'deepseek',                            // 实例 name，用于模型调用记录归属
);
```

**为什么删掉早期的 `DeepSeekProvider` 子类**：

| 原因 | 说明 |
|---|---|
| 零行为增量 | 子类只有一个构造函数 `super(baseUrl \|\| '…', apiKey, 'deepseek')`，无任何覆写方法 |
| 风格不对称 | `openai` 走「工厂传参」、`deepseek` 走「子类」，两种同类厂商两种写法，是 code smell |
| 扩展点是闲置的 | 保留它的唯一正当理由是「将来 DeepSeek 出现 OpenAI 协议之外的专有逻辑」。DeepSeek 真正独有的差异（`reasoning_content` 思维链）已经**在通用 Provider 里处理掉了**（见第二节「推理过程」），不需要靠子类；至今没有剩下任何必须子类化的东西 |
| 文档成本 | 一个 12 行的类要占掉一节文档 + 文件树 + 索引表多处引用 |

**删它时有两个坑必须避开**（否则会静默改变行为）：

1. **`DEFAULT_BASE_URL.deepseek` 不能删**。它不只给工厂兜底用，`LlmConfigService.resolveBaseUrl()`
   在创建/编辑配置时也靠它把默认地址**持久化进数据库**。删掉这个 key，新建 DeepSeek 配置会得到 `null` baseUrl。
2. **第三个参数 `name` 必须与 provider 类型同名**。`AiProvider.name` 会被 `agent.service.ts`、
   `llm.executor.ts`、`embedding.service.ts` 直接写进 `ModelCallLog.provider`，仪表盘按它分组统计。
   现在工厂把 `provider` 变量本身传进去（见第六节，天然保证同名）；但只要有人改成传字面量或省略该参数，
   就会回落成默认的 `'openai-compatible'`，历史记录和新记录被拆成两个桶。
   同理 `openai-compatible` 分支**不要**改传 `'custom'` 之类的新名字。

> **判断标准（以后新增厂商照这个来）**：只有出现「OpenAI 协议装不下」的专有逻辑
> （自定义 Header、额外参数、不同的错误码格式、`/embeddings` 缺失要单独报错等）才建子类；
> 仅仅是 baseUrl / 名字不同的，一律走工厂传参。

---

## 六、ProviderFactory — 动态构造

**文件路径**：`backend/src/ai/providers/provider.factory.ts`

```typescript
export function createProvider(input: ProviderConnectionInput): AiProvider {
  const { provider, baseUrl, apiKey } = input;

  switch (provider) {
    case 'ollama':
      return new OllamaProvider(baseUrl || undefined);   // 不传 → 走默认 localhost:11434

    // openai / deepseek 共用同一个分支：只差「默认 baseUrl」和「实例 name」，
    // 而这两者都能从 provider 类型本身推出来
    case 'openai':
    case 'deepseek':
      return new OpenAICompatibleProvider(
        baseUrl || DEFAULT_BASE_URL[provider],           // openai → api.openai.com/v1
                                                         // deepseek → api.deepseek.com/v1
        apiKey || undefined,
        provider,                                        // name 与类型同名（写进 ModelCallLog.provider）
      );

    case 'openai-compatible':
      if (!baseUrl) throw new Error('openai-compatible 类型必须提供 baseUrl');  // ← 无默认值，必填
      return new OpenAICompatibleProvider(baseUrl, apiKey || undefined);       // name 默认 'openai-compatible'

    default:
      throw new Error(`不支持的提供商类型: ${provider}`);
  }
}
```

**为什么 `openai` 和 `deepseek` 能合并成一个 `case`**：两者的构造参数完全由 `provider` 类型决定——
`DEFAULT_BASE_URL[provider]` 取默认地址、`provider` 本身当 `name`。合并后新增同类厂商只要
「往 `DEFAULT_BASE_URL` 加一条 + 挂到这个 case 上」，不用再复制一段几乎相同的 `new`。

**`openai-compatible` 不能并进来**：它没有默认 baseUrl（缺了要抛错），行为真的不同。

> ⚠️ 合并时**不能顺手把 `'deepseek'` 从 `LlmProviderType` 里删掉**。类型和实现类是两件事：
> `LlmProviderConfig.provider` 列里已经存着 `'deepseek'` 的历史数据、前端下拉框要显示「DeepSeek」、
> `LlmConfigService.resolveBaseUrl()` 也靠这个值决定默认地址。删类型 = 数据迁移 + 破坏已有配置。
> 能删的是**实现类**（见第五节），不是**枚举值**。

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
| 推理过程字段 | `message.thinking` | `delta.reasoning_content`（或 `reasoning`） |

Provider 层各自处理自己的协议细节，上层 AgentService 和 WorkflowEngine 完全不感知——
它们只看 `ChatStreamChunk`（`{ type:'content'|'reasoning', text }`）和 `ToolChatResult` 这种统一抽象。

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

两个 Provider 的 `chatWithTools` 都在用：**解析模型返回的 `tool_calls`** 时走 `stringifyToolArguments`
（把 arguments 统一成 JSON 字符串，Ollama 返回的可能是对象、OpenAI 返回的是字符串）；
**回填历史消息**时走 `parseToolArguments`（`toOllamaMessages` 要把字符串 arguments 转回对象，
Agent 执行工具时也要先 parse 成对象）。
不修这个兼容层，「经第三方转发的云端模型」的工具调用会**静默丢参数**，是最难排查的一类线上问题。

---

## 八、telemetry 与 ModelCallLog —— Provider 之上还有一层监控

**文件路径**：`backend/src/ai/ai.service.ts`（`recordModelCall` 公有方法 —— 工作流节点 / Agent 等调用方也会直接用它补记非 `AIService` 路径的调用）

AIService 在每次调用（`complete` / `chat` / `streamChat` / `chatWithTools`）**结束后**都会
调**一次** `recordModelCall(telemetry, meta)` 写 `ModelCallLog` —— 成功记 `SUCCESS`（带 token 用量），
异常记 `FAILED`（带 `errorCode` / `errorMessage`）后原样 `throw`，**不会**同一次调用写两条。
仪表盘「Token 用量」「模型排行」的数据来源（详见 [08](./08-MCP-Skill-Storage-其他模块.md) Dashboard 章节）。

```typescript
// 公有方法（不是 private）：llm.executor / AgentService / EmbeddingService 也会直接调它
async recordModelCall(
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

调用点（新增 Provider 调用路径时必须同步补记录）：工作流 `llm.executor` 三路（`:270` 等处）、`AgentService.runStream`
多轮（经 `recordAgentCall` 转发，`agent.service.ts:1044`）、`EmbeddingService.embedBatch`（`embedding.service.ts:97`，EMBEDDING）。
错误分类（`SUCCESS` / `FAILED` / `errorCode`）也在这一层完成。

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
| `openai-compatible.provider.ts` `pickReasoning()` | **推理字段也过同一个归一化**：`reasoning_content` / `reasoning` 可能是字符串，也可能是内容块数组 |
| `ollama.provider.ts` | 同上四处（含 `message.thinking`） |
| `agent.service.ts` `persistAssistantMessage` + tool_calls 分支 | 落库前再过一遍，防任何 Provider 漏网 |

> **为什么放在 Provider 边界而不是落库前**：这样 Agent 聊天和工作流 LLM 节点**同时受益**，
> 上层拿到的 `content` 天然就是字符串，不需要各自防御。
> `deepseek` / `openai-compatible` 复用 `OpenAICompatibleProvider`，一并覆盖。
