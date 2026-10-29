# 06 - 知识库与 RAG

> 阅读本文后，你应该能回答：文档上传后怎么变成向量的？向量化用的什么模型？换个 Embedding 模型要怎么安全地迁移历史数据？pgvector 检索有几种模式？RAG 检索服务怎么被复用？

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
    │  4. ChunkService.split() → 分块 → DocumentChunk 入库（只存文本，不存向量）
    │  5. EmbeddingVersionService.ensureActiveVersion(kbId) → 拿到当前生效版本
    │     （含 modelId / llmModelId / dimensions / vectorTable）
    │  6. EmbeddingService.embedBatch(texts, 生效版本的 modelId, llmModelId)
    │  7. 维度校验：vector.length === 生效版本.dimensions（不再是写死的 768）
    │  8. EmbeddingVersionService.writeVectors() → 写入版本专属物理表
    │     "EmbeddingVector_<versionId>"（vector(dimensions) + HNSW 索引）
    │  9. status = COMPLETED（失败 → FAILED + errorMessage）
```

> ⚠️ **向量不再写进 `DocumentChunk.embedding`**。`DocumentChunk` 现在只存**文本块**，
> 向量按「版本」存在各自独立的物理表 `EmbeddingVector_<versionId>` 里。详见 §六。

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
>
> 向量化改造后：向量路径走版本物理表（`vectorSearchInTable`），同样**没有**文档状态过滤；
> 但版本状态有保护 —— 未 `READY`/未激活的版本**完全不参与检索**，所以「正在重新向量化」的中间态不会污染召回。

---

## 四、DocumentParserService — 文档解析

4 种 Parser 按文件扩展名路由（白名单共 **5 个**扩展名：`.pdf` / `.docx` / `.txt` / `.md` / `.markdown`）：

| 扩展名 | Parser | 依赖 |
|---|---|---|
| `.pdf` | PdfParser | pdf-parse |
| `.docx` | DocxParser | mammoth |
| `.md` / `.markdown` | MarkdownParser | 直接 fs.readFile |
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
  // 入口先整体清洗（去 C0/C1 控制字符、孤立代理项、U+FFFE/U+FFFF）
  const chunks = await this.splitter.splitText(sanitizeText(text));
  return chunks
    .map((content, index) => ({ content, chunkIndex: index }))
    .map((content, index) => ({
      content: sanitizeText(content).trim(),   // 逐块再清洗 + trim
      chunkIndex: index,
    }));
}
```

> 100 字符在中文场景下偏小（约 60~70 字），容易把完整段落切碎。如果要调整，只能改这里的常量——目前没有走 config 或环境变量。

### ★ sanitizeText — 22021 报错的根因修复

`pdf-parse` 输出的文本可能含 `\u0000` 等 NUL 字节，而 PostgreSQL 的 `text` 列**不接受 NUL**，
直接写入会抛 `22021 invalid byte sequence`（知识库向量化的头号疑难报错）。
`backend/src/common/text.util.ts` 的 `sanitizeText()` 负责清洗，**三处调用**：

| 位置 | 时机 |
|---|---|
| `document-parser.service.ts` `parse()` 出口 | 解析完立即整体清洗 |
| `chunk.service.ts` `split()` 入口 | 切块前清洗（避免控制字符切碎语义） |
| `chunk.service.ts` `createMany()` 落库前 | 逐块清洗 + `trim()` + **丢弃空块**（`content.trim().length > 0`） |

### ChunkService.createMany() — 批量入库

```typescript
async createMany(documentId, knowledgeBaseId, chunks) {
  if (chunks.length === 0) return [];

  return this.prisma.$transaction(async (tx) => {
    const created = await tx.documentChunk.createMany({
      data: chunks.map(c => ({
        documentId,
        content: sanitizeText(c.content),      // ← 落库前兜底清洗
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

Embedding 维度必须和**当前生效向量版本的 `dimensions`** 一致（不再是知识库上一个写死的 768）。
版本物理表的列是 `vector(dimensions)`，维度不匹配会导致写入失败，
`writeVectors()` 会**逐条**校验：不符的判为该 chunk 的 `FAILED` 并记录原因，不影响其它 chunk。

---

## 六、向量版本化（Embedding Versioning）— 新增

**文件路径**：`backend/src/knowledge/embedding/embedding-version.service.ts`

### 为什么需要

pgvector 的 HNSW / IVFFlat 索引**只能建在有固定维度的 `vector(N)` 列上**，
`vector`（无维度）列上建索引会直接报错。而换 Embedding 模型几乎必然换维度
（nomic-embed-text 768 / bge-m3 1024 / text-embedding-3-small 1536）。

所以「改知识库的 embeddingModel + embeddingDimension」**不等于**换了向量：
`DocumentChunk.embedding` 列是 `vector(768)`，把维度改成 1024 只是改了个元数据，
新向量根本写不进去，老向量也没重新生成 —— 检索结果会静默错乱。

**解法：文本块与向量解耦，每个版本一张物理表。**

```
DocumentChunk            ← 只存文本块（解析一次，永久复用）
    │
    ├── EmbeddingVector_<v1>  vector(768)   + HNSW   ← nomic-embed-text
    ├── EmbeddingVector_<v2>  vector(1024)  + HNSW   ← bge-m3
    └── EmbeddingVector_<v3>  vector(1536)  + HNSW   ← text-embedding-3-small
```

不同模型 / 不同维度的向量**物理隔离**，永远不会混进同一个检索空间。

### 两张表

```prisma
model KnowledgeBaseEmbeddingVersion {
  id              String  @id
  knowledgeBaseId String
  modelId         String   // 真实模型标识，如 "bge-m3"
  llmModelId      String?  // 指向 LlmModel（用户配置的云端模型）时的 id
  dimensions      Int      // 该版本的向量维度
  vectorTable     String   // 物理表名，如 "EmbeddingVector_4d75adfea7f44bdb97295590829ed226"
  status          String   // PENDING | PROCESSING | READY | FAILED | ARCHIVED
  isActive        Boolean  // 是否为该知识库的生效版本（同一 KB 只有一个 true）
  chunkTotal      Int      // 需要向量化的文本块总数
  chunkDone       Int
  chunkFailed     Int
  error           String?
  activatedAt     DateTime?
}

model DocumentChunkEmbedding {
  id                String @id
  chunkId           String
  embeddingVersionId String
  status            String  // PENDING | DONE | FAILED   ← 只记状态，不存向量
  error             String?
}
```

> `DocumentChunkEmbedding` **只有状态没有向量列**——向量在物理表里。
> 它存在的意义是：记录每个 chunk 在每个版本下的完成情况，支持进度统计与**失败项单独重试**。

### 版本状态机

```
PENDING ──► PROCESSING ──► READY ──► (激活) ──► isActive = true
                │              ▲                      │
                └──► FAILED ───┘（重试失败项）        └──► ARCHIVED（被新版本顶下）
```

| 状态 | 含义 | 能否激活 |
|---|---|---|
| `PENDING` | 已建表 + 已登记待处理 chunk，还没跑 | ❌ |
| `PROCESSING` | 正在重新向量化 | ❌ |
| `READY` | 全部完成（`chunkFailed = 0` 且 done = total） | ✅ |
| `FAILED` | 有失败项或任务异常 | ❌（可重试失败项） |
| `ARCHIVED` | 曾被激活，现已被新版本顶下 | ❌（状态不是 `READY`，直接激活会被 400 拒绝；需先重跑 re-embed 回到 `READY`） |

### 换模型的完整流程

```
1. 模型管理页给目标模型打上 EMBEDDING 能力 → 点「验证」实测出维度写入 embeddingDimensions
2. POST /knowledge-bases/:id/embedding-versions          → 创建目标版本（PENDING）
      · 校验模型有 EMBEDDING 能力、有实测维度
      · 建物理表 EmbeddingVector_<id>（vector(dimensions) + HNSW）
      · seedPendingChunks()：把 KB 下所有 chunk 登记为 PENDING
3. POST .../embedding-versions/:versionId/re-embed       → 入队 knowledge-reembed
      · 复用已有文本块，不重新解析原文件
      · 逐条校验维度 → 写物理表 → 更新 DONE/FAILED
      · 前端每 3s 轮询进度（chunkDone / chunkTotal / chunkFailed）
4. POST .../embedding-versions/:versionId/activate       → 原子切换生效
```

**激活是原子的**（一个事务里做三件事）：

```typescript
await this.prisma.$transaction([
  // ① 当前生效版本下线
  updateMany({ where: { knowledgeBaseId, isActive: true },
               data: { isActive: false, status: 'ARCHIVED' } }),
  // ② 目标版本上线
  update({ where: { id: versionId }, data: { isActive: true, activatedAt: new Date() } }),
  // ③ 同步知识库主记录（展示用），保证「配置」与「实际检索向量」一致
  update({ where: { id: kbId }, data: {
    embeddingModel: version.modelId,
    embeddingLlmModelId: version.llmModelId,
    embeddingDimension: version.dimensions,
  }}),
]);
```

> 只有 `READY` 的版本才允许激活 —— 防止跑到一半的版本顶上来导致检索空窗。
> **旧版本下线后 `status` 变成 `ARCHIVED`，记录和物理表都保留**，但要回滚必须先让它重新跑成 `READY`
> （`activateVersion()` 的守卫是 `status !== READY → 400`，不会对 `ARCHIVED` 网开一面）。

### 关键约束（踩过的坑）

| 坑 | 说明 |
|---|---|
| 无维度列建不了索引 | `vector`（不带 N）上建 HNSW/IVFFlat 直接报错 → 必须一个版本一张 `vector(N)` 表 |
| 维度不能靠名字猜 | 必须由 `verifyModel()` 真实调用实测；`createTargetVersion()` 拿不到维度会直接 400 |
| 查询向量必须用同模型 | 检索时按**每个 KB 的生效版本**各自向量化，维度不符的版本会被跳过（不会报错，只 warn） |
| 不能删生效版本 | `deleteVersion()` 对 `isActive` 的版本硬拒绝，需先切到别的版本 |

---

## 七、VectorStoreService — pgvector 封装

**文件路径**：`backend/src/knowledge/vector/vector-store.service.ts`

### 向量写入

#### 写入版本物理表（当前主路径）

由 `EmbeddingVersionService.writeVectors()` 调用，写进 `EmbeddingVector_<versionId>`：

```sql
INSERT INTO "EmbeddingVector_<versionId>" ("chunkId", "embedding")
VALUES ($1::text, $2::vector)
ON CONFLICT ("chunkId") DO UPDATE SET "embedding" = EXCLUDED."embedding"
```

写入前**逐条**校验 `vector.length === version.dimensions`，不符的登记为 `FAILED` 并记原因，不中断整批。

#### 单条更新（旧路径，仅作兼容保留）

```sql
UPDATE "DocumentChunk" SET "embedding" = $1::vector WHERE "id" = $2::text
```

#### 批量更新（旧路径，仅作兼容保留）

用 `unnest()` 一次灌进去，比一条条 UPDATE 快一个数量级：

```sql
UPDATE "DocumentChunk" AS dc
SET "embedding" = v.vec::vector
FROM unnest($1::text[], $2::text[]) AS v(id, vec)
WHERE dc."id" = v.id
```

> ⚠️ 这两条旧路径**只在「该知识库还没有任何向量版本」的兼容回退场景**下使用。
> 正常流程一律走版本物理表。

### 向量检索 — 余弦距离

#### 按版本表检索（当前主路径）— `vectorSearchInTable()`

```sql
SELECT
  dc."id" AS "chunkId", dc."documentId", d."knowledgeBaseId",
  dc.content, dc.metadata, d."fileName",
  v."embedding" <=> $1::vector AS distance
FROM "EmbeddingVector_<versionId>" v
JOIN "DocumentChunk" dc ON dc."id" = v."chunkId"
JOIN "Document" d       ON d."id" = dc."documentId"
WHERE d."knowledgeBaseId" = ANY($2::text[])
  AND v."embedding" <=> $1::vector <= $3
ORDER BY v."embedding" <=> $1::vector ASC
LIMIT $4
```

表名由系统生成（`EmbeddingVector_<uuid>`），**不来自用户输入**，所以这里用 `$queryRawUnsafe` 拼表名是安全的。

#### 旧检索（兼容回退）

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

## 八、KnowledgeRetrievalService — 统一检索入口

**文件路径**：`backend/src/knowledge/retrieval/knowledge-retrieval.service.ts`

上层节点（RAG Node / LLM Node 简单模式 / Agent Knowledge Tool）都调用这一个服务。

### 三种检索模式

#### vector（纯向量）

1. `searchForQuery()`：**按每个知识库各自的生效版本**把 query 向量化
2. `searchAcrossActiveVersions()` → `vectorSearchInTable()` 到各版本物理表检索
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

### searchForQuery() — 按生效版本向量化（当前主路径）

```typescript
private async searchForQuery(query, knowledgeBaseIds, explicitModel?, telemetry?, topK = 20) {
  // ① 取这些 KB 的所有「生效版本」
  const versions = await this.prisma.knowledgeBaseEmbeddingVersion.findMany({
    where: { knowledgeBaseId: { in: knowledgeBaseIds }, isActive: true },
    select: { id, knowledgeBaseId, modelId, llmModelId, dimensions, vectorTable },
  });

  // ② 兼容回退：还没建过向量版本 → 沿用旧的 DocumentChunk.embedding
  if (versions.length === 0) {
    const v = await this.embed(query, explicitModel, knowledgeBaseIds, telemetry);
    return this.vectorStoreService.vectorSearch(knowledgeBaseIds, v, topK, 1.0);
  }

  // ③ 按【每个版本各自的模型】分别向量化，各自检索，再合并
  const buckets = await Promise.all(versions.map(async (v) => {
    const [vector] = await this.embeddingService.embedBatch(
      [query],
      explicitModel ?? v.modelId,
      explicitModel ? null : v.llmModelId,
      telemetry,
    );
    // 维度不符 → 跳过该版本（只 warn，不让整次检索挂掉）
    if (vector?.length !== v.dimensions) return [];
    return this.vectorStoreService.vectorSearchInTable(v.vectorTable, [v.knowledgeBaseId], vector, ...);
  }));

  return buckets.flat().sort((a, b) => a.distance - b.distance).slice(0, topK);
}
```

> **核心原则**：查询向量化必须和入库向量化用**同一个模型**——否则向量空间不一致，检索精度为零。
> 所以这里是「每个 KB 用自己生效版本的模型各向量化一次」，而不是全局共用一个模型。
> 这同时解决了多知识库各自绑不同 Embedding 模型时的混检问题。

### resolveEmbedding() — 旧模型解析（仅兼容回退使用）

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

> 只在 `versions.length === 0`（知识库还没建向量版本）时走到这里。
> 生效后 `KnowledgeBase.embeddingModel/embeddingDimension` 由 `activateVersion()` 同步维护，
> 所以这俩字段现在**只是展示用的元数据**，真正的检索依据是「生效版本」。

---

## 九、两个 BullMQ 队列

### document-processing — 文档解析 + 首次向量化

**文件路径**：`backend/src/queues/document-processing/document.processor.ts`

**失败重试入口**：`POST /documents/:id/reprocess`（`documents.controller.ts:156-183`）——
校验 owner 后把文档状态重置为 `UPLOADED` 并重新入队（attempts: 3，指数退避 3000ms），
用来在向量化失败后「重新处理」而不必重新上传文件。

### 空文本预检（扫描件保护）

`document.processor.ts:84-88`：解析结果若**没有任何有效文本**（扫描件 / 图片型 PDF 的典型表现），
直接抛错把文档标记 `FAILED` 并给出可读原因（「未能从该文件中提取到有效文本内容，可能是扫描件或图片型 PDF，需先做 OCR」）——
**不静默标记 COMPLETED**，避免用户误以为向量化成功了。

### 向量化遥测

`document.processor.ts:111-142`：向量化前解析归属空间（优先知识库关联的工作空间，否则回退知识库 owner 的可见空间），
构造 `telemetry` 传给 `embedBatch()` —— 写入 `ModelCallLog`，仪表盘才能统计「向量化花了多少 token」。

### 维度校验（整批前置）

`embedBatch()` 之后、`writeVectors()` 之前，`document.processor.ts:153-161` 先用
`vectors[0].length !== activeVersion.dimensions` 做**整批校验**：不符直接 throw →
**整篇文档标记 FAILED**（错误消息是中文可操作提示，指引用户去切换向量模型建新版本）。
`writeVectors()` 内部的逐条 FAILED 只是兜底。

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

### 与向量版本的衔接

向量化这一步不再自己决定用哪个模型：

```typescript
// document.processor.ts
const activeVersion = await this.versionService.ensureActiveVersion(knowledgeBaseId);
const vectors = await this.embeddingService.embedBatch(
  texts, activeVersion.modelId, activeVersion.llmModelId, telemetry,
);
// 维度不符 → 该 chunk 判失败并记原因
await this.versionService.writeVectors(activeVersion.id, pairs);
```

> `ensureActiveVersion()`：没有生效版本时，按知识库当前配置**自动建 v1 并激活**，
> 并用 `seedChunks: true` 把存量文本块登记为 PENDING 待补向量化（保证升级前的老知识库开箱即用，
> 迁移脚本已为存量库建好 v1）。
> 原来那个写死的 `EMBEDDING_DIMENSION = 768` 常量**已删除**。

---

### knowledge-reembed — 重新向量化（新增）

**文件路径**：`backend/src/queues/re-embedding/re-embedding.processor.ts`

```typescript
@Processor('knowledge-reembed')
export class ReEmbeddingProcessor extends WorkerHost {
  const BATCH_SIZE = 64;   // 每批向量化的文本块数量

  async process(job: Job<ReEmbedJobData>) {
    // 1. version.status = 'PROCESSING'
    // 2. 取出未完成项（PENDING / FAILED）—— 支持「只重试失败项」
    // 3. 分批 embedBatch(version.modelId, version.llmModelId)
    // 4. writeVectors() 写入版本物理表（逐条维度校验）
    // 5. 没返回向量的条目 → markChunksFailed('模型未返回向量')
    // 6. refreshStats() 更新 chunkDone/chunkFailed，全部完成且无失败 → status = READY
    // 7. job.updateProgress(5 → 95 → 100)
  }
}
```

**关键特性**：

| 特性 | 说明 |
|---|---|
| 不重新解析文件 | 复用 `DocumentChunk` 已有文本块，只重新生成向量（省掉最贵的解析步骤） |
| 失败可重试 | 只捞 `PENDING / FAILED` 的 chunk，重跑不会动已 `DONE` 的 |
| 逐条维度校验 | 维度不符的 chunk 单独标记失败并记录原因，不拖垮整批 |
| 进度可查 | `job.updateProgress()` + 版本表 `chunkDone/chunkTotal/chunkFailed`，前端每 3s 轮询 |
| 完成才可激活 | `chunkFailed = 0` 且 done = total 才置 `READY`，未 `READY` 不让激活 |

> **注册位置容易记错**：两条队列都**不在** `queues.module.ts` 里 `registerQueue`。
> `queues.module.ts` 只做一件事 —— 把 3 个 Processor 挂成 provider（`DocumentProcessor` /
> `WorkflowProcessor` / `ReEmbeddingProcessor`）。真正的 `BullModule.registerQueue` 写在**用队列的业务模块**里：
> `knowledge.module.ts:27`（`document-processing`）、`:30`（`knowledge-reembed`）、
> `workflows.module.ts:38`（`workflow-execution`）、`chat-files.module.ts:32`（`chat-file-processing`）
> —— 另外 `platform-tools.module.ts:52` 也声明了 `document-processing`，供平台助理挂文档时入队。
> `knowledge-reembed` 依赖 Redis，Redis 没起时任务会堆积不执行。
