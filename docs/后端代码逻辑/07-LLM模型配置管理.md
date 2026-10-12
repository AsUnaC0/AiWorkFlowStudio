# 07 - LLM 模型配置管理

> 阅读本文后，你应该能回答：用户添加的云端模型配置怎么存？API Key 怎么保护？运行时怎么动态绑定到 Provider？连接测试做了什么？

---

## 一、整体架构

```
前端「模型管理」页面
    │  创建 / 测试 / 拉取模型列表 / 设置默认
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
  capabilities    String[] @default(["CHAT", "STREAM"])  // 取值：CHAT | STREAM | TOOLS | EMBEDDING（注意是 TOOLS 不是 TOOL_CALL）
  enabled         Boolean  // 是否启用
  isDefault       Boolean  // 每个 owner 只有一个默认
}
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
    return { ok: false, error: err.message };
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
  };
}
```

### 其余对外方法（此前文档漏了 5 个）

| 方法 | 作用 |
|---|---|
| `resolveChatProvider(llmModelId?)` | 便捷封装：有 id 就返回解析出的 provider，**没有就返回 null**（调用方看到 null 应回退全局 Ollama） |
| `getModelName(llmModelId)` | 只取 `LlmModel.modelId`（如 `deepseek-ai/DeepSeek-V4-Flash`）。AgentService 用它把 `Agent.model` 列同步成真实模型名 |
| `listModels(userId, capability?)` | 列出当前用户**启用**的模型，可按能力过滤（`capabilities: { has: capability }`），排序 `isDefault desc, createdAt asc` |
| `updateModel(userId, modelId, dto)` | 改 displayName / capabilities / enabled |
| `setDefaultModel(userId, modelId)` | 事务里先把该 owner 所有 `isDefault=true` 置 false，再把目标置 true —— 保证同一 owner 只有一个默认模型 |

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
