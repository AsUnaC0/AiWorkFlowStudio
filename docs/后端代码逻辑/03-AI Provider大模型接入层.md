# 03 - AI Provider 大模型接入层

> 阅读本文后，你应该能回答：为什么 `AI_PROVIDER` Symbol 能变成真实的大模型调用？3 种 Provider 各自怎么发 HTTP 请求？流式和非流式怎么解析返回值？Function Calling 的数据怎么传递？

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
- `ChatMessage`：`{ role: 'system'|'user'|'assistant'|'tool', content, tool_calls?, tool_call_id? }`
- `ChatOptions`：`{ model: string, temperature?, maxTokens? }`
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
    options: { temperature: 0.7 },
  }),
})
```

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
    'Authorization': `Bearer ${apiKey}`,    // ← 云端需要 API Key
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

构造函数里有个 `normalizeBaseUrl()`：如果用户误把 `/chat/completions` 当成 baseUrl 填了，会自动剥离后缀保留到 `/v1` 根。这样后续拼接 `/chat/completions`、`/models`、`/embeddings` 都不会重复。

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

**调用方**：`LlmConfigService.resolveModelRuntime()` — 解密 API Key → `createProvider()` → 返回可用的 `{ provider, modelId, providerType }`。

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
