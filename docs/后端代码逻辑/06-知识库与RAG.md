# 06 - 知识库与 RAG

> 阅读本文后，你应该能回答：文档上传后怎么变成向量的？向量化用的什么模型？pgvector 检索有几种模式？RAG 检索服务怎么被复用？

---

## 一、整体流水线

```
前端上传文件（docx/pdf/md/txt）
    │
    ▼
DocumentController (POST /knowledge-bases/:kbId/documents)
    │  1. assertKbOwner 校验 + 文件非空 + 扩展名白名单校验
    │  2. multer 接收文件 → StorageService.upload(buffer, originalname, `documents/${kbId}`)
    │     → 拿到 { key, size }
    │  3. Document 记录入库（storagePath = uploaded.key, status = UPLOADED）
    │  4. 入队 document-processing Queue（attempts: 3, exponential backoff 3000ms）
    ▼
DocumentProcessor (BullMQ Worker)
    │  1. 更新 status = PROCESSING
    │  2. StorageService.getLocalPath() → 拿到可读取的本地路径（七牛云会先下载）
    │  3. DocumentParserService.parse() → 按文件类型选对应 Parser → 纯文本
    │  4. ChunkService.split() → 分块 → DocumentChunk 入库
    │  5. EmbeddingService.embedBatch() → 批量向量化
    │  6. 维度校验（768）
    │  7. VectorStoreService.updateEmbeddingBatch() → 批量写 pgvector
    │  8. status = COMPLETED（失败 → FAILED + errorMessage）
```

---

## 二、KnowledgeService — 知识库 CRUD

### 创建知识库

```typescript
async create(userId, dto) {
  return this.prisma.knowledgeBase.create({
    data: {
      ownerId: userId,
      name: dto.name,
      description: dto.description,
      embeddingModel: dto.embeddingModel,           // Ollama 本地模型名，默认 nomic-embed-text
      embeddingDimension: dto.embeddingDimension,   // 向量维度，默认 768
      embeddingLlmModelId: dto.embeddingLlmModelId ?? null,  // 可选：自定义 Embedding 模型
    },
  });
}
```

### 删除知识库

删除时先取出所有 document 的 `storagePath` → 通过 StorageService 逐个物理删除（本地 unlink / 七牛云 API 删除）→ 再 Prisma 级联删除 DB 记录。

### Workspace 关联

KnowledgeBase 可以独立于 Workspace 存在，也可以关联进去。关联表是 `WorkspaceKnowledgeBase`，`upsert` 避免重复。

---

## 三、DocumentService — 文档 CRUD + 文件管理

### create() — 创建文档记录

1. Prisma `document.create()` → 写入元数据
2. 自动 `knowledgeBase.documentCount += 1`

### remove() — 删除文档

1. StorageService.delete(storagePath) → 物理删除文件
2. Prisma `document.delete()` → DB 级联删除 chunks
3. 重算知识库的 `documentCount` 和 `chunkCount`

### 状态机

```
UPLOADED → PROCESSING → COMPLETED
                      → FAILED
```

> ⚠️ **"只有 COMPLETED 的文档才会被 RAG 检索到"这句话在当前实现里并没有落地。**
> `VectorStoreService.vectorSearch()` / `keywordSearch()` 的 WHERE 条件只有：
> ```sql
> WHERE d."knowledgeBaseId" = ANY($n::text[])
>   AND dc."embedding" IS NOT NULL       -- 向量模式额外有距离阈值
> ```
> **没有 `d.status = 'COMPLETED'` 过滤**。因为失败的文档通常没有 embedding，实践中影响不大；但 PROCESSING 中已写入 embedding 的 chunk **会被检索出来**。
> 如果业务上必须保证只召回已完成文档，需要在这两条 SQL 里补 `AND d."status" = 'COMPLETED'`。

---

## 四、DocumentParserService — 文档解析

4 种 Parser 按文件扩展名路由：

| 扩展名 | Parser | 依赖 |
|---|---|---|
| `.pdf` | PdfParser | pdf-parse |
| `.docx` | DocxParser | mammoth |
| `.md` | MarkdownParser | 直接 fs.readFile |
| `.txt` | TxtParser | 直接 fs.readFile |

### ChunkService.split() — 分块

用 LangChain 的 `RecursiveCharacterTextSplitter`，按字符数递归切分并带 overlap（重叠区）防止语义断裂。

```typescript
// ⚠️ 参数是硬编码的，目前【不可配置】
private readonly splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 100,      // 不是 1000
  chunkOverlap: 50,
});

async split(text: string) {
  const chunks = await this.splitter.splitText(text);
  return chunks.map((content, index) => ({ content, chunkIndex: index }));
}
```

> 100 字符在中文场景下偏小（约 60~70 字），容易把完整段落切碎。如果要调整，只能改这里的常量——目前没有走 config 或环境变量。

### ChunkService.createMany() — 批量入库

```typescript
async createMany(documentId, knowledgeBaseId, chunks) {
  if (chunks.length === 0) return [];

  return this.prisma.$transaction(async (tx) => {
    const created = await tx.documentChunk.createMany({
      data: chunks.map(c => ({
        documentId,
        content: c.content,
        chunkIndex: c.chunkIndex,     // ← 存的是 chunkIndex，不是 metadata
      })),
    });
    // 同步累加知识库 chunkCount（在同一个事务里，保证计数准确）
    await tx.knowledgeBase.update({
      where: { id: knowledgeBaseId },
      data: { chunkCount: { increment: created.count } },
    });
    return created;
  });
}
```

> 注意：`DocumentChunk` 表里**没有** `knowledgeBaseId` 字段（文档归属通过 `documentId → Document.knowledgeBaseId` 关联），也没有用 `skipDuplicates`。

---

## 五、EmbeddingService — 向量化

### 调用链

```
EmbeddingService.embedBatch(texts[], model, llmModelId)
    │
    ├── llmModelId 有值 → LlmConfigService.resolveModelRuntime() → 云端 Provider
    └── 否则 → AIService.getProvider() → 全局 Ollama

    → provider.embedding(texts, { model })   // 分批，BATCH_SIZE=100
```

### 两种 Provider 的 embedding 端点

| Provider | Endpoint |
|---|---|
| Ollama | `POST http://localhost:11434/api/embeddings` |
| OpenAI 兼容 | `POST {baseUrl}/embeddings` |

返回值都是 `number[][]`（每个 chunk 一个向量）。

### 维度校验

Embedding 维度必须和知识库绑定的 `embeddingDimension`（默认 768）一致。VectorStore 的 pgvector 列是 `vector(768)`，维度不匹配会导致写入失败。

---

## 六、VectorStoreService — pgvector 封装

**文件路径**：`backend/src/knowledge/vector/vector-store.service.ts`

### 向量写入

#### 单条更新

```typescript
UPDATE "DocumentChunk" SET "embedding" = $1::vector WHERE "id" = $2::text
```

#### 批量更新（高效）

用 `unnest()` 一次灌进去，比一条条 UPDATE 快一个数量级：

```sql
UPDATE "DocumentChunk" AS dc
SET "embedding" = v.vec::vector
FROM unnest($1::text[], $2::text[]) AS v(id, vec)
WHERE dc."id" = v.id
```

### 向量检索 — 余弦距离

```sql
SELECT dc.content, dc."embedding" <=> $1::vector AS distance
FROM "DocumentChunk" dc
JOIN "Document" d ON d."id" = dc."documentId"
WHERE d."knowledgeBaseId" = ANY($2::text[])
  AND dc."embedding" IS NOT NULL
  AND dc."embedding" <=> $1::vector <= $3     -- 距离阈值（越小越严格）
ORDER BY dc."embedding" <=> $1::vector ASC
LIMIT $4
```

`<=>` 是 pgvector 的余弦距离运算符，返回 0-2 之间的值。**距离越小越相似**。

### 关键词检索 — PostgreSQL 全文检索

```sql
SELECT dc.content,
       ts_rank(to_tsvector('simple', dc.content),
               plainto_tsquery('simple', $1)) AS rank
FROM "DocumentChunk" dc
WHERE d."knowledgeBaseId" = ANY($2::text[])
  AND to_tsvector('simple', dc.content) @@ plainto_tsquery('simple', $1)
ORDER BY rank DESC
LIMIT $3
```

用 `simple` 分词器（不依赖 zhparser 扩展，兼容中英文）。

---

## 七、KnowledgeRetrievalService — 统一检索入口

**文件路径**：`backend/src/knowledge/retrieval/knowledge-retrieval.service.ts`

上层节点（RAG Node / LLM Node 简单模式 / Agent Knowledge Tool）都调用这一个服务。

### 三种检索模式

#### vector（纯向量）

1. 用 EmbeddingService 把 query 向量化
2. VectorStoreService.vectorSearch()
3. 相似度 = 1 - 余弦距离（统一语义：越大越好）

#### keyword（纯关键词）

1. 直接调用 VectorStoreService.keywordSearch()
2. score = ts_rank（PostgreSQL 原生相关度）

#### hybrid（混合，默认）

**Reciprocal Rank Fusion（RRF）融合**：
```
并发跑 vector(topK*4) + keyword(topK*4)
对每个 chunk：
  fusedScore = Σ 1/(k + rank_i + 1)     // k = 60，业界默认
按 fusedScore 排序 → 取 topK
```

为什么 RRF 好？向量检索擅长语义相似，关键词检索擅长精确匹配。RRF 不依赖两者 score 的量纲，只看排名，实现简单且效果稳定。

### resolveEmbedding() — 模型解析

```typescript
private async resolveEmbedding(model, knowledgeBaseIds) {
  if (model) return { model, llmModelId: null };     // ① 调用方显式指定 → 直接用
  if (knowledgeBaseIds.length === 0) {               // ② 没传知识库 → 兜底本地模型
    return { model: 'nomic-embed-text', llmModelId: null };
  }
  // ③ 否则取【第一个】知识库绑定的配置（多库混绑时只认 kb[0]，是个已知简化）
  const kb = await this.prisma.knowledgeBase.findUnique({
    where: { id: knowledgeBaseIds[0] },
    select: { embeddingModel: true, embeddingLlmModelId: true },
  });
  return {
    model: kb?.embeddingModel ?? 'nomic-embed-text',
    llmModelId: kb?.embeddingLlmModelId ?? null,   // 自定义 embedding 模型优先于 embeddingModel
  };
}
```

查询向量化必须和入库向量化用**同一个模型**——否则向量空间不一致，检索精度为零。

---

## 八、DocumentProcessor — 异步文档处理

**文件路径**：`backend/src/queues/document-processing/document.processor.ts`

### 幂等保护

重试时先清理上一次残留的 chunks：
```typescript
if (existingCount > 0) {
  await this.prisma.$transaction(async tx => {
    await tx.documentChunk.deleteMany({ where: { documentId } });
    await tx.knowledgeBase.update({
      where: { id: knowledgeBaseId },
      data: { chunkCount: { decrement: existingCount } },
    });
  });
}
```

### 进度报告

每步调 `job.updateProgress(n)`：10% 解析 → 30% 分块 → 50% 入库 → 80% 向量化 → 100% 完成。前端可以实时显示。

### 七牛云临时文件清理

七牛云模式下 `storageService.getLocalPath()` 会先下载到临时文件。`finally` 块里 `unlink(tempPath)` 确保清理，不管成功还是失败。
