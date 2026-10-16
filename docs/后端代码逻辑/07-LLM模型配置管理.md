# 07 - LLM 模型配置管理

> 阅读本文后，你应该能回答：用户添加的云端模型配置怎么存？API Key 怎么保护？运行时怎么动态绑定到 Provider？连接测试做了什么？

---

## 一、整体架构

```
前端「模型管理」页面
    │  创建 / 测试 / 拉取模型列表(只拉不落) / 勾选添加 / 单模型删除 / 验证能力 / 设置默认
    ▼
LlmConfigController
    ▼
LlmConfigService
    │  PrismaService → LlmProviderConfig + LlmModel 两张表
    │  EncryptionService → API Key 加密存储
    │  createProvider() → 构造 Provider 实例做连接测试
    ▼
运行时被 AgentService / WorkflowEngine / KnowledgeRetrievalService 调用：
    llmConfigService.resolveModelRuntime(llmModelId)
        → 解密 API Key → createProvider() → { provider, modelId, providerType }
```

---

## 二、数据模型

### LlmProviderConfig（Provider 级）

```typescript
model LlmProviderConfig {
  id              String   @id
  ownerId         String   // 用户 ID
  name            String   // "我的 DeepSeek"、"公司 Ollama"
  provider        String   // ollama | openai | deepseek | openai-compatible
  baseUrl         String?  // 云端必填；ollama 可选（默认 http://localhost:11434）
  encryptedApiKey String?  // AES 加密后的 API Key（ollama 不需要）
  status          String   // UNKNOWN | CONNECTED | ERROR | DISABLED
  lastError       String?
  models          LlmModel[]
}
```

### LlmModel（模型级，一个 Config 下可以有多个）

```typescript
model LlmModel {
  id              String   @id
  configId        String   // 外键 → LlmProviderConfig
  provider        String   // 冗余存储（方便查询）
  modelId         String   // 真实模型标识（如 "deepseek-ai/DeepSeek-V4-Flash"）
  displayName     String   // 用户友好名（如 "DeepSeek V4 Flash"）
  capabilities    String[] @default(["CHAT", "STREAM"])  // 8 值，见下方表格（注意是 TOOLS 不是 TOOL_CALL）
  enabled         Boolean  // 是否启用
  isDefault       Boolean  // 每个 owner 只有一个默认

  // ↓↓↓ 以下 6 个是「模型能力体系」升级新增的字段
  inputModalities     String[] @default(["text"])  // 输入模态：text | image | audio
  outputModalities    String[] @default(["text"])  // 输出模态：text | image | audio
  embeddingDimensions Int?     // 向量输出维度，仅 EMBEDDING 有意义；由「验证模型」实测写入
  maxInputTokens      Int?     // 上下文窗口上限（可选，用于前端提示 / 截断判断）
  isVerified          Boolean  @default(false)     // 是否跑过真实调用验证
  verifiedAt          DateTime?                    // 上次验证通过时间
}
```

### capabilities 的 8 个取值（多选，非互斥）

枚举定义在 `backend/src/llm-config/llm-config.dto.ts` 的 `MODEL_CAPABILITIES`：

| 值 | 含义 | 谁在消费 |
|---|---|---|
| `CHAT` | 单轮 / 多轮对话（`complete`） | 聊天、LLM 节点、`resolveUserDefaultChatModel()` |
| `STREAM` | 流式输出（`streamChat`） | 需要打字机效果的前端 |
| `TOOLS` | 函数调用 / 工具调用（`chatWithTools`） | Agent 工具调用、MCP |
| `EMBEDDING` | 文本向量化（`embedding`） | **知识库向量化**；`listModels('EMBEDDING')` 选择器 |
| `VISION` | 图像理解（输入模态含 image） | 多模态对话 |
| `REASONING` | 推理 / 慢思考模型 | 需要 CoT 的场景 |
| `RERANK` | 重排序 | 检索结果 rerank |
| `IMAGE_GENERATION` | 文生图 | 图片生成场景 |

> ⚠️ 能力之间是**多选并存**关系，不是互斥单选。一个模型可以同时是 `['CHAT','STREAM','TOOLS','VISION','REASONING']`。
> 前端标签与 hover 提示见 `fronted/src/types/provider.ts` 的 `CAPABILITY_LABELS` / `CAPABILITY_TIPS`。

模态（`MODALITIES`）独立于能力，取值 `text | image | audio`，分输入 / 输出两套：
```typescript
export const MODALITIES = ['text', 'image', 'audio'] as const;
```

---

## 三、API Key 加密存储

### 写入时

```typescript
// 创建配置时（先校验：provider !== 'ollama' 却没有 apiKey → BadRequestException）
if (dto.apiKey) {
  data.encryptedApiKey = this.encryption.encrypt(dto.apiKey);
}

// 更新时：只有「传了」且「不是空字符串」才覆盖
//   → 传空字符串 = 不改；不传 = 不改；传新值 = 换 Key
if (dto.apiKey !== undefined && dto.apiKey !== '') {
  data.encryptedApiKey = this.encryption.encrypt(dto.apiKey);
}
```

### 读取时

```typescript
// 运行时构造 Provider
const plainKey = this.encryption.decrypt(config.encryptedApiKey);
const provider = createProvider({ provider, baseUrl, apiKey: plainKey });
```

### 脱敏显示

返回给前端时永远不返回明文：
```typescript
private toConfigView(config) {
  const { encryptedApiKey, ...rest } = config;      // ← 密文永远不会出现在返回值里
  const plain = encryptedApiKey ? encryption.decrypt(encryptedApiKey) : null;
  return {
    ...rest,
    apiKeyMasked: encryption.maskApiKey(plain),     // "前4位****后4位"，如 sk-a****1234
    hasApiKey: !!encryptedApiKey,
  };
}
```

**算法细节**：AES-**256-GCM**，密文格式 `base64(iv):base64(authTag):base64(ciphertext)`（三段用 `:` 分隔）。
`maskApiKey`：长度 ≤ 8 → `****`；否则 `前4位 + '****' + 后4位`；传 null → null。

**密钥来源（优先级依次降低）**：
```
LLM_CONFIG_ENCRYPTION_KEY  →  JWT_SECRET  →  'dev-only-insecure-key-change-me'
```
取到后统一 `sha256` 摘要成 32 字节。

> ⚠️ 环境变量名是 **`LLM_CONFIG_ENCRYPTION_KEY`**（不是 `ENCRYPTION_KEY`）。未配置时打 warn 并回退到 `JWT_SECRET`——**这意味着改 JWT_SECRET 会让库里已存的 API Key 全部解不开**，生产环境务必单独配。

---

## 四、连接测试

### testBeforeSave() — 保存前测试（表单校验）

不落库，直接用表单数据构造 Provider → `listModels()`：

```typescript
async testBeforeSave(dto) {
  const provider = createProvider({ provider: dto.provider, baseUrl, apiKey: dto.apiKey });
  try {
    const models = (await provider.listModels?.()) ?? [];
    return { ok: true, models };
  } catch (err) {
    return {
      ok: false,
      models: [] as string[],   // ← 失败也返回空数组，前端别 undefined 解构
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
```

### testSaved() — 已保存配置测试

从 DB 读配置 → 构造 Provider → `listModels()` → 回写 `status` 和 `lastError`。

### listModels() — 拉取可用模型

调用 `provider.listModels()`（Provider 各自实现）：

| Provider | listModels 端点 |
|---|---|
| Ollama | `GET {baseUrl}/api/tags` → 取 `models[].name` |
| OpenAI 兼容 | `GET {baseUrl}/models` → 取 `data[].id` |

`fetchModels()` 会把拉到的模型 **upsert** 到 LlmModel 表（按 `@@unique([configId, modelId])` 幂等），成功后 `status = CONNECTED` + 清空 lastError；失败则 `status = ERROR` + 写 lastError 并抛 BadRequestException。

> ⚠️ **capabilities 不会自动识别**：upsert 时写死 `capabilities: ['CHAT', 'STREAM']`。
> 所以从云端拉下来的 **EMBEDDING 模型不会被标记成 EMBEDDING**，在知识库选择器（`listModels('EMBEDDING')`）里看不到，必须用户在模型管理页手工改 capabilities 才能用。
> 同理 `embeddingDimensions` 默认也是 `null`，**必须点「验证」让后端实测写入**，否则创建向量版本时拿不到可信维度。

### listRemoteModels() — 只拉不落（弹窗勾选用）

`fetchModels()` 是「拉取 + 全量落库」，实际使用很少了；前端「获取模型」按钮现在走 `listRemoteModels()`：

```typescript
async listRemoteModels(userId: string, id: string) {
  const provider = this.buildProviderFromConfig(config);
  const remoteModels = (await provider.listModels?.()) ?? [];
  // 失败 → status = ERROR + 写 lastError + 抛 BadRequestException
  // 成功 → status = CONNECTED + 清空 lastError
  const existing = await this.prisma.llmModel.findMany({
    where: { configId: id }, select: { modelId: true },
  });
  return { models: remoteModels, existing: existing.map(m => m.modelId) };
}
```

返回 `{ models, existing }`：**不写库**，前端用 `existing` 把已添加的模型打上「已添加」标签，用户勾选后再调 `addModels()`。

### addModels() / removeModel() — 单个模型增删

```typescript
// 只添加用户指定的 modelIds（去重 + trim + 过滤空串），空数组 → 400「请至少选择一个模型」
async addModels(userId, id, dto) {
  for (const modelId of modelIds) {
    await this.upsertModel(id, config.provider, modelId, {
      capabilities: dto.capabilities,
      displayName: modelIds.length === 1 ? dto.displayName : undefined, // 仅单个时用自定义名
    });
  }
  return this.listConfigModels(id);   // 返回该配置下全部模型
}

// 删除单个模型，不影响配置本身
async removeModel(userId, modelId) {
  await this.prisma.llmModel.delete({ where: { id: modelId } });
  return { id: modelId, deleted: true, wasDefault: model.isDefault };
}
```

> 这样解决了「手动填了 modelId 却被迫全量拉取一堆用不上的模型」的问题：填 id 就只加这一个。

### verifyModel() — 实测验证（新增）

**接口**：`POST /llm-configs/models/:id/verify`

```typescript
async verifyModel(userId: string, modelId: string) {
  const { provider } = await this.resolveModelRuntime(modelId);

  if (model.capabilities.includes('EMBEDDING')) {
    const res = await provider.embedding(['维度校验'], { model: model.modelId });
    const dim = res.embeddings?.[0]?.length ?? 0;      // ← 真实跑一次拿维度，不靠名称猜
    if (!dim) throw new Error('未返回任何向量，无法确定输出维度');
    // 写回 embeddingDimensions + isVerified=true + verifiedAt=now()
    return { ok: true, dimensions: dim, latencyMs, checked: ['embedding'] };
  }

  await provider.complete('ping', { model: model.modelId, maxTokens: 16 });
  // 只写 isVerified / verifiedAt
  return { ok: true, dimensions: null, latencyMs, checked: ['chat'] };

  // catch：isVerified = false，返回 { ok: false, error }
}
```

| 返回字段 | 说明 |
|---|---|
| `ok` | 是否通过 |
| `dimensions` | EMBEDDING 模型的**实测**输出维度（如 768 / 1024）；非 EMBEDDING 为 `null` |
| `latencyMs` | 耗时 |
| `checked` | `['embedding']` 或 `['chat']` |
| `error` | 失败原因 |

> **为什么必须有这一步**：向量维度不能从模型名猜（`text-embedding-3-small` 是 1536、`nomic-embed-text` 是 768、`bge-m3` 是 1024）。
> 创建知识库向量版本时后端会按 `embeddingDimensions` 建 `vector(N)` 物理表，维度错了会直接写不进去。

### baseUrl 解析规则（resolveBaseUrl）

```typescript
if (baseUrl) return baseUrl;                              // 用户填了就用填的
if (provider === 'openai')             return DEFAULT_BASE_URL.openai;      // https://api.openai.com/v1
if (provider === 'deepseek')           return DEFAULT_BASE_URL.deepseek;    // https://api.deepseek.com/v1
if (provider === 'openai-compatible')  throw new BadRequestException('openai-compatible 必须提供 baseUrl');
return null;                                              // ollama：留空，运行时取 localhost:11434
```

---

## 五、resolveModelRuntime — 运行时动态绑定

**这是整个模块最重要的方法**，被 AgentService、WorkflowEngine、EmbeddingService 三处复用：

```typescript
async resolveModelRuntime(modelId: string) {
  const model = await this.prisma.llmModel.findUniqueOrThrow({
    where: { id: modelId },
    select: {
      modelId: true,
      config: { select: { provider: true, baseUrl: true, encryptedApiKey: true } },
    },
  });

  // 解密
  const plainKey = model.config.encryptedApiKey
    ? this.encryption.decrypt(model.config.encryptedApiKey)
    : null;

  // 工厂函数构造 Provider（每次都是 new 的，用完即弃）
  const provider = createProvider({
    provider: model.config.provider,
    baseUrl: model.config.baseUrl ?? null,
    apiKey: plainKey,
  });

  return {
    provider,                // 可用的 AiProvider 实例（每次 new，用完即弃）
    modelId: model.modelId,  // 真实模型标识（传给 provider.chat() 的 model 参数）
    providerType,            // 'ollama' | 'openai' | 'deepseek' | 'openai-compatible'
    capabilities,            // ModelCapability[]（调用方据此判断能否走流式 STREAM / 视觉 VISION 等）
  };
}
```

### 其余对外方法（含「模型能力体系」升级新增的 5 个）

| 方法 | 作用 |
|---|---|
| `resolveChatProvider(llmModelId?)` | 便捷封装：有 id 就返回解析出的 provider，**没有就返回 null**（调用方看到 null 应回退全局 Ollama） |
| `getModelName(llmModelId)` | 只取 `LlmModel.modelId`（如 `deepseek-ai/DeepSeek-V4-Flash`）。AgentService 用它把 `Agent.model` 列同步成真实模型名 |
| `listModels(userId, capability?)` | 列出当前用户**启用**的模型，可按能力过滤（`capabilities: { has: capability }`），排序 `isDefault desc, createdAt asc` |
| `updateModel(userId, modelId, dto)` | 改 displayName / capabilities / enabled，**以及新增的** inputModalities / outputModalities / embeddingDimensions / maxInputTokens |
| **`listRemoteModels(userId, configId)`** | **只拉远端模型不落库**，返回 `{ models, existing }` 供前端弹窗勾选 |
| **`addModels(userId, configId, dto)`** | 只添加用户指定的模型（幂等 upsert），返回该配置下全部模型 |
| **`removeModel(userId, modelId)`** | 删除单个模型，返回 `{ id, deleted, wasDefault }` |
| **`verifyModel(userId, modelId)`** | 实测验证：EMBEDDING 跑一次 embedding 写回真实维度，其它跑一次 `complete('ping')` |
| `setDefaultModel(userId, modelId)` | 事务里先把该 owner 所有 `isDefault=true` 置 false，再把目标置 true —— 保证同一 owner 只有一个默认模型 |
| **`resolveUserDefaultChatModel(userId)`** | 取「当前用户的默认对话模型」：`enabled=true` + `capabilities has 'CHAT'`，排序 `isDefault desc, createdAt asc`，返回 `{ llmModelId, modelName, provider, capabilities }`；**找不到返回 null**（底层调 `resolveModelRuntime()`，解析失败也返回 null）。用途见下方说明 |
| **`listOwnedModelIds(userId)`** | 取当前用户拥有的**全部**模型 id（**含未启用**）。用途是归属校验 —— 平台助理生成工作流 / Agent 时，模型可能传一个不属于该用户的 `llmModelId`，据此拒绝 |

#### `resolveUserDefaultChatModel()` 是给谁用的

**平台助理**（见 [11](./11-平台助理.md)）是一份 Agent 记录服务所有用户，所以它**不能绑定固定模型**
（`Agent.llmModelId` 为 `null`）。运行时由 `AgentService.runStream()` 调这个方法，
**按每个用户各自的默认对话模型解析**；返回 `null` 才回退全局 Ollama。

```typescript
// agent.service.ts
if (agent.llmModelId) {
  const runtime = await this.llmConfigService.resolveModelRuntime(agent.llmModelId);
  chatBackend = runtime.provider;
  chatModel   = runtime.modelId;
} else if (isPlatformAssistant) {
  const preferred = await this.llmConfigService.resolveUserDefaultChatModel(userId);
  if (preferred) {
    chatBackend = preferred.provider;
    chatModel   = preferred.modelName;
  }
}
```

> 所以「我在模型管理里设了默认模型，为什么平台助理用的还是 Ollama」这类问题的排查顺序是：
> 该模型是否 `enabled`、是否有 `CHAT` 能力、`resolveModelRuntime()` 能否成功解密并构造 Provider。

> 另：`update()` 还支持 `dto.disabled` → `status = 'DISABLED' | 'UNKNOWN'`，等于一个软开关。

**调用方怎么用**（以 AgentService.runStream 为例）：

```typescript
let chatBackend: AiProvider = this.aiService.getProvider();  // 默认 Ollama 单例
let chatModel = agent.model;

if (agent.llmModelId) {
  // 绑定了自定义云端模型 → 动态构造
  const runtime = await this.llmConfigService.resolveModelRuntime(agent.llmModelId);
  chatBackend = runtime.provider;     // ← 替换成云端 Provider
  chatModel = runtime.modelId;        // ← 替换成真实模型标识
}
```

---

## 六、设计总结

| 设计点 | 做法 |
|---|---|
| API Key 保护 | AES 加密存 DB，运行时才解密；返回前端脱敏 |
| 动态 vs 静态 | 默认 Ollama 走 NestJS DI（单例），云端模型走工厂函数（每次 new） |
| 复用 | `resolveModelRuntime()` 统一入口，Agent/Workflow/Embedding 都从这里拿 Provider |
| 防串用 | 运行时查 LlmModel → LlmProviderConfig → 解密 → 构造，不会拿错 key |
| 多租户 | LlmProviderConfig.ownerId 确保只能看到自己的配置 |
| 能力建模 | `capabilities` 8 值多选（非互斥）+ 输入/输出模态独立建模；选择器按 `has` 过滤 |
| 维度可信 | `embeddingDimensions` 由 `verifyModel()` **真实调用实测**写入，不靠模型名猜；`isVerified`/`verifiedAt` 记录验证状态 |
| 按需添加 | `listRemoteModels`（只拉不落）+ 前端勾选 + `addModels`，避免全量拉取一堆用不上的模型 |
