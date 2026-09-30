# AI WorkFlow Studio 学习指南
## 第 7 篇：后端知识库与 RAG —— 上传的 PDF 怎么变成「能回答问题的向量」

> **本篇核心**：走过两条路：
> **① 写入路**：`POST /api/knowledge-bases/:kbId/documents` 上传 PDF → 落地磁盘 → 解析成文本 → 切块 → 向量化 → 写进 pgvector。
> **② 检索路**：工作流的 RAG 节点拿到用户问题 → 向量化 → 从 pgvector 找出最像的片段 → 拼进下游 LLM 的上下文。
>
> 这是整个项目**最实用**的功能，也是看裸 SQL 的绝佳教材。

---

## 1. 心智模型：一本书是怎么「进脑子」的

```
         写入路（upload）                         检索路（rag）
用户上传《员工手册.pdf》                   用户问「报销标准多少？」
     │                                          │
     ▼                                          ▼
┌──────────────────┐                     ┌──────────────────┐
│ 落地磁盘 uploads/ │                     │ 你 → 一个问题      │
│ kb-uuid/xxx.pdf  │                     └────────┬─────────┘
└────────┬─────────┘                              ▼
         ▼                                  EmbeddingService
┌──────────────────┐                     nomic-embed-text → 768 维向量
│ 解析成纯文本       │                           ▼
│ pdf-parse 抽文字   │                  VectorStoreService.vectorSearch
└────────┬─────────┘                SQL: embedding <=> 你的向量 < 0.8
         ▼                                  排最像的前 5
┌──────────────────┐                           ▼
│ 切块 Recursive   │              命中文本拼成【知识库参考】
│ chunkSize 1000   │                 ┌──────────────────┐
│ chunkOverlap 200 │                 │ RAG 节点输出：      │
└────────┬─────────┘                 │【问题】...          │
         ▼                           │【知识库参考】        │
┌──────────────────┐                 │[1] ... [2] ...      │
│ 批量 Embedding    │                 └────────┬─────────┘
│ 每批 100 条       │                           ▼
└────────┬─────────┘                 LLM 节点 systemPrompt 里用
         ▼                           {{rag_1.output}} → 结合资料回答
┌──────────────────┐
│ unnest 批量写库    │
│ chunk.embedding   │
└──────────────────┘
```

写入路被文档抓包子 → 检索路回答问题。**两条路共享同一套向量格式。**

---

## 2. 数据库回顾：哪张表存了什么（重点）

```
KnowledgeBase（你建的知识库）
├── embeddingModel     "nomic-embed-text"      ← 用什么模型向量化
├── embeddingDimension 768                      ← 向量几维
├── documentCount      冗余计数
└── chunkCount         冗余计数
        │ 1:N
        ▼
Document（一篇文档）
├── fileName / fileType / fileSize
├── storagePath        ← 磁盘路径 uploads/<kbId>/<docId>.pdf
├── status             UPLOADED → PROCESSING → COMPLETED / FAILED
└── errorMessage       FAILED 的原因
        │ 1:N
        ▼
DocumentChunk（一个文本块）
├── content            ← 切出来的~1000字符文本
├── chunkIndex         ← 第几块
└── embedding vector(768)   ← ★ 手写 migration 加的列，Prisma 不认识
```

**最关键的一句**（第 2 篇强调过，这里是实战）：`embedding` 列是手写的，
Prisma 不能增删查它，**所有向量的读写都是裸 SQL**（`VectorStoreService`）。

---

## 3. 知识库 CRUD（接口+权限）

`knowledge.controller.ts`，整个 Controller 加了 `@UseGuards(JwtAuthGuard)`。

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| POST | `/knowledge-bases` | 登录即可 | 建库，`ownerId = 当前用户` |
| GET | `/knowledge-bases` | 登录即可 | 只列 `ownerId = 我` 的库 |
| GET | `/knowledge-bases/:id` | **owner** | 404 不存在 / 403 不是我的 |
| PUT | `/knowledge-bases/:id` | **owner** | 更新 |
| DELETE | `/knowledge-bases/:id` | **owner** | 删库（级联删文档+chunks+磁盘目录） |
| GET | `/workspaces/:wsId/knowledge-bases` | workspace member | 该空间关联的库 |
| POST | `/workspaces/:wsId/knowledge-bases/:kbId` | **workspace member 且 kb owner** | 关联到空间 |
| DELETE | `/workspaces/:wsId/knowledge-bases/:kbId` | workspace member | 解绑 |

**创建接口的 DTO：**

```typescript
export class CreateKnowledgeBaseDto {
  @IsString() @IsNotEmpty() @MaxLength(200) name: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsString() @IsNotEmpty() @MaxLength(100) embeddingModel: string;
  @IsInt() @Min(1) @Max(8192) embeddingDimension: number;
}
```

前端默认提交 `embeddingModel: "nomic-embed-text"`、`embeddingDimension: 768`。
**这是一对容易配错的参数**：必须和 Ollama 里真实存在的模型、模型真实输出维度一致（第 5 节讲症状）。

**删除还删了磁盘文件（两种删）：**

```typescript
// 删知识库：先删整个目录，再删 DB 记录
const storageDir = join(UPLOAD_DIR, id);
await rm(storageDir, { recursive: true, force: true });   // ← force 不存在的目录不报错
return this.prisma.knowledgeBase.delete({ ... });

// 删单个文档：先删文件，再删记录，然后重算两个计数
await unlink(doc.storagePath);
await this.prisma.document.delete({ where: { id } });
const [documentCount, chunkCount] = await Promise.all([  // ★ 删除时重算，保证准确
  this.prisma.document.count({ ... }),
  this.prisma.documentChunk.count({ ... }),
]);
await this.prisma.knowledgeBase.update({ data: { documentCount, chunkCount } });
```

注意两种计数维护策略不同：

| 场景 | 策略 |
|------|------|
| 上传（`document.service.create`） | `increment: 1`（增量） |
| 增加 chunk（`chunk.service.createMany`） | `increment: created.count`（增量） |
| 删除（`document.service.remove`） | **重算**（`count()` 新数值写回） |

增用增量是为了快，删用重算是为了稳妥 —— 反正删除频率低。

---

## 4. ★ 写入路：上传一个 PDF 的完整流程

`documents.controller.ts` 的 `upload`，这是全后端**最长的一个 Controller 方法**（~100 行）。

### 4.1 前置：文件拦截器

```typescript
@Post('knowledge-bases/:kbId/documents')
@UseInterceptors(
  FileInterceptor('file', {
    limits: { fileSize: MAX_FILE_SIZE },   // 50MB
    defParamCharset: 'utf8',
  }),
)
async upload(
  @CurrentUser() user,
  @Param('kbId', ParseUUIDPipe) kbId,
  @UploadedFile() file: { originalname, buffer, size, mimetype, ... },
)
```

- 表单字段名必须是 **`file`**（前端 `formData.append("file", file)` 一致）
- multipart 解析交给 `FileInterceptor`，文件内容已经在内存 `buffer` 里
- 超过 50MB 会被 limits 直接拦（400）

### 4.2 分步走

```typescript
// ① 权限：必须是知识库 owner
await this.documentService.assertKbOwner(user.id, kbId);

// ② 格式白名单（不是"能解析的全部格式"，而是"允许传的格式"）
const ext = extname(file.originalname).toLowerCase();
if (!ALLOWED_EXTENSIONS.includes(ext)) {   // .pdf .docx .txt .md .markdown
  throw new HttpException('不支持的文件类型...', 400);
}

// ③ 落地磁盘：uploads/<kbId>/<documentId><ext>
const documentId = crypto.randomUUID();
const storageDir = join(UPLOAD_DIR, kbId);
const storagePath = join(storageDir, `${documentId}${ext}`);
await mkdir(storageDir, { recursive: true });
await writeFile(storagePath, file.buffer);

// ④ 建文档记录（状态 PROCESSING）
const doc = await this.documentService.create({
  knowledgeBaseId: kbId,
  fileName: file.originalname,
  fileType: EXT_TO_TYPE[ext] ?? ...,
  fileSize: file.size,
  storagePath,
  mimeType: file.mimetype,
  status: 'PROCESSING',
});

// ⑤ 同步处理管线
try {
  const kb = await this.prisma.knowledgeBase.findUnique({
    where: { id: kbId }, select: { embeddingModel: true },
  });

  const text = await this.documentParserService.parse(storagePath);  // 解析
  const chunks = await this.chunkService.split(text);                // 切块
  await this.chunkService.createMany(doc.id, kbId, chunks);          // chunks 入库

  const storedChunks = await this.prisma.documentChunk.findMany({    // 取回（embedding 全 null）
    where: { documentId: doc.id },
    select: { id: true, content: true },
  });

  if (storedChunks.length > 0) {
    const vectors = await this.embeddingService.embedBatch(
      storedChunks.map((c) => c.content),
      kb.embeddingModel,                                             // ★ 用知识库配置的模型
    );
    await this.vectorStoreService.updateEmbeddingBatch(
      storedChunks.map((c, i) => ({ chunkId: c.id, vector: vectors[i] })),
    );
  }

  await this.documentService.updateStatus(doc.id, 'COMPLETED');
} catch (err) {
  await this.documentService.updateStatus(doc.id, 'FAILED', message);
  throw new HttpException(`文档处理失败：${message}`, 500);
}

return this.documentService.findOne(doc.id);
```

**几个值得注意的点：**

| 点 | 说明 |
|----|------|
| **同步处理** | 一整条管线在请求里做完。大文件/慢 Ollama 会让请求卡很久（无队列） |
| **状态机** | `PROCESSING` → 成 `COMPLETED`，败 `FAILED` + 错误消息。前端靠刷新看最终状态 |
| **embeddingModel 从哪来** | 知识库记录！**不能用节点里的模型**，否则维度对不上 |
| **先入库再更新向量** | 因为 Prisma 只能插非 embedding 列，所以先 `createMany` 再裸 `UPDATE` |

### 4.3 四种解析器

| 类型 | 实现 | 现有状态 |
|------|------|---------|
| PDF | `pdf-parse` | ✅ 可用 |
| TXT / MD | 直接 `readFile(utf-8)` | ✅ 可用 |
| DOCX | `throw new Error('DOCX 解析尚未实现')` | ❌ **会直接报 FAILED** |

> **⚠️ 上传 `.docx` 一定会转 FAILED**（解析器没实现）。表单允许传 docx，但处理必挂。
> 这算半成品功能。想补的话用 `mammoth` 之类库替换 `DocxParser.parse` 即可。

### 4.4 切块参数 `ChunkService`

```typescript
private readonly splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 1000,      // 每块约 1000 字符
  chunkOverlap: 200,    // 相邻块重叠 200 字符
});
```

**chunkOverlap 为什么不设 0？** 防止一句话/表格在块边界被切断。
检索回到第 2 块时，如果不知道前文，可能需要第 1 块的尾巴。重叠 200 字符保住上下文。

### 4.5 批量向量化 `EmbeddingService`

```typescript
async embedBatch(texts: string[], model: string): Promise<number[][]> {
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {   // 每批 100 条
    ...
    const result = await this.aiService.embedding(batch, { model });
    allVectors.push(...result.embeddings);
  }
}
```

- 交给 `AIService` → Ollama `/api/embed`
- **一批 100 条**，防止单次请求体太大
- `model` 必须和 `nomic-embed-text` 一致（取决于你建库时填的）

### 4.6 ★ 批量写向量：一次 UPDATE 100 个 chunk

`vector-store.service.ts`：

```typescript
const sql = `
  UPDATE "DocumentChunk" AS dc
  SET "embedding" = v.vec::vector
  FROM unnest($1::text[], $2::text[]) AS v(id, vec)
  WHERE dc."id" = v.id
`;
await this.prisma.$executeRawUnsafe(sql, ids, vectors);
```

**拆解：**

| 部分 | 意思 |
|------|------|
| `FROM unnest($1::text[], $2::text[]) AS v(id, vec)` | 把 `ids` 和 `vectors` 两个数组「摊平」成一张 `(id, vec)` 临时表 |
| `$1` / `$2` | PostgreSQL 原生参数占位符（`Unsafe` 的原因是这种展开用不了 Prisma 标签模板语法） |
| `::text[]` | ★ 数组元素是 text。因为 Prisma 的 `String` 映射成 PostgreSQL `TEXT`，不是 `uuid`。写 `::uuid[]` 会类型报错 |
| 一步 SET | 跟循环 100 次 `UPDATE ... WHERE id = ?` 相比，**少 100 次网络往返** |

---

## 5. ★ 检索路：RAG 节点怎么找到「答案段落」

### 5.1 三种检索模式总览（`VectorStoreService`）

| 模式 | 检索 SQL 核心 | 适合 |
|------|--------------|------|
| **vector** | `embedding <=> query` 余弦距离 | 语义相近但字面不同的提问 |
| **keyword** | PostgreSQL `to_tsvector` 全文检索 | 精确名词（型号、人名、专有名词） |
| **hybrid** | 两路并跑 + RRF 融合 | ★ 日常推荐 |

### 5.2 向量检索（`vectorSearch`）

```typescript
const rows = await this.prisma.$queryRaw<VectorHit[]>`
  SELECT
    dc."id"              AS "chunkId",
    dc."documentId",
    d."knowledgeBaseId",
    dc.content,
    dc."embedding" <=> ${vectorString}::vector AS distance
  FROM "DocumentChunk" dc
  JOIN "Document" d ON d."id" = dc."documentId"      -- ★ 必须 JOIN！
  WHERE d."knowledgeBaseId" = ANY(${knowledgeBaseIds}::text[])
    AND dc."embedding" IS NOT NULL                    -- 跳过来不及向量化的块
    AND dc."embedding" <=> ${vectorString}::vector <= ${threshold}
  ORDER BY dc."embedding" <=> ${vectorString}::vector ASC
  LIMIT ${topK}
`;
```

**三个必懂点：**

| 点 | 为什么 |
|----|--------|
| **`<=>` 是余弦距离** | pgvector 提供。**越小越像**。所以 `ORDER BY ... ASC`（最像在前） |
| **必须 JOIN Document** | `knowledgeBaseId` 在 `Document` 表上，`DocumentChunk` 没有这列 |
| **`ANY(${ids}::text[])`** | `knowledgeBaseId IN (多个库)` —— RAG 节点可能选了多个知识库 |

**threshold（距离阈值）怎么理解：**
传 `threshold = 0.8` = **只保留距离 ≤ 0.8 的 chunk**。0 是完美匹配，1 以上基本不相关。
RAG 节点默认 `0.8`，前端提示"0.5~0.8 常用"。阈值设太大 → 召回一些没关系的片段；太小 → 可能没有命中。

### 5.3 关键词检索（`keywordSearch`）

```typescript
const rows = await this.prisma.$queryRaw<KeywordHit[]>`
  SELECT ..., 
    ts_rank(to_tsvector('simple', dc.content), plainto_tsquery('simple', ${query})) AS rank
  FROM "DocumentChunk" dc
  JOIN "Document" d ON d."id" = dc."documentId"
  WHERE d."knowledgeBaseId" = ANY(${knowledgeBaseIds}::text[])
    AND to_tsvector('simple', dc.content) @@ plainto_tsquery('simple', ${query})
  ORDER BY rank DESC
  LIMIT ${topK}
`;
```

- `to_tsvector('simple', content)` 给内容建**全文索引向量**
- `plainto_tsquery('simple', query)` 把查询转成查询树
- `@@` 运算符 = 「匹配上的保留」
- `ts_rank` 打分，`rank DESC` 最相关在前
- 用 `'simple'` 分词器（不装 `zhparser` 扩展也能兼容中文）

### 5.4 混合检索（`hybridSearch`）—— 本项目 RAG 节点默认

核心是 **RRF（Reciprocal Rank Fusion）** 分数融合：

```
score(chunk) = Σ  1 / (k + rank_i)
```

```typescript
const k = 60;   // RRF 常数（业界常用值）

const [vectorHits, keywordHits] = await Promise.all([
  this.vectorSearch(ids, queryVector, topK * 2, 1.0),   // 向量多取一倍
  this.keywordSearch(ids, query, topK * 2),
]);

vectorHits.forEach((h, rank) => {
  scores.set(h.chunkId, (scores.get(h.chunkId) ?? 0) + 1 / (k + rank + 1));
});
keywordHits.forEach((h, rank) => {
  scores.set(h.chunkId, (scores.get(h.chunkId) ?? 0) + 1 / (k + rank + 1));
});
// 按融合分降序取 topK
```

**为什么用「排名」而不是直接用向量距离/全文分数？**
两种检索的分数范数完全不同（向量距离是 0~2，关键词 rank 是 0~N）。直接相加会被大数的那个带偏。
RRF 只关心「你排第几」，两个检索各给排名分（`1/(60+rank+1)`），天然可以公平相加。

**举例**：某 chunk 在两个检索里都排第 1 → 分 = `1/61 + 1/61 = 0.0328`。
只有向量排第 3 → 分 = `1/63 = 0.0159`。两个都命中 = 高分，这就是「互补」。

> 注意：`vectorSearch` 在 hybrid 里传了 `threshold = 1.0`（几乎不筛），
> 因为融合层已经够保守了，先不要太激进地丢。

### 5.5 结果从上到下到 LLM 的「标准格式」

RAG 节点（第 4 篇讲过）把 hits 拼成：

```
【问题】
报销标准是多少？

【知识库参考】
[1] 根据《员工出差管理办法》，市区内交通费每人每天 30 元……
[2] 市外出差需提前提交申请，住宿标准为……
```

格式里明确分「问题」和「知识库参考」，方便 LLM 区分「用户问什么」和「背景资料是什么」。
下游 LLM 节点的 systemPrompt 用 `{{rag_1.output}}` 引用这段，userPrompt 用 `{{input}}`（或留空取上一个节点的输出即 RAG 的文本）。

---

## 6. 完整闭环例子：一个「客服回答」工作流

```
[Start] 用户在聊天框问："我们的退款政策？"
   │
   ▼
[RAG 节点]  config:
     knowledgeBaseIds: ["kb-uuid"],
     queryTemplate: "查询退款政策相关信息：{{input}}",
     searchMode: "hybrid",
     topK: 5,
     threshold: 0.8,
     embeddingModel: "nomic-embed-text"
   │  输出 = 【问题】...【知识库参考】[1]...[2]...[5]...
   ▼
[LLM 节点]   config:
     model: "qwen2.5:7b",
     prompt: "你是客服助手，请只依据【知识库参考】回答，不要编造：",
     userPrompt: "{{rag_1.output}}"      ★ 把检索结果喂给模型
   │  输出 = "根据公司政策，您可以在购买后 30 天内无条件退款……"
   ▼
[Output 节点]
   │
   ▼
前端看到答案
```

**关键点**：`userPrompt` 写 `{{rag_1.output}}`（引用整段检索文本），
`prompt`（system）可以在引用前给出约束。这就是「RAG = 检索 + 模板 + 生成」三段式。

---

## 7. ⚠️ 已知缺陷与坑

| # | 问题 | 后果 | 建议 |
|---|------|------|------|
| 1 | `embeddingModel` 填错或维度填错 | 上传向量化 500 / 检索报 `expected 768 dimensions, not 1024` | 建库就填对；检索时报维度错先查这个 |
| 2 | DOCX 解析未实现 | 传 docx → FAILED | 用 `mammoth` 补 `DocxParser` |
| 3 | Chat 页 `knowledgeBaseIds` 被无视 | 网页聊天不带知识库 | 接 `/ai/chat` 前面的 TODO 或用 RAG 工作流 |
| 4 | `KnowledgeRetrievalService` 是**半成品** | 里面的 `vectorSearch` / `keywordSearch` / `embed` 全 `throw`，只 RRF 骨架可用 | 需要统一检索入口时再把它接进 `VectorStoreService` |
| 5 | 上传是**同步**的 | 大 PDF + 慢 Ollama 会让请求挂很久 | 后续引入队列（BullMQ / 简单 setTimeout 任务） |
| 6 | `pageCount`、`tokenCount` 字段声明了但不赋值 | 永远 null | 真用的时候再补逻辑 |
| 7 | 原始 SQL 里表名大小写 | `"DocumentChunk"` 双引号区分大小写 | 写 SQL 时保持一致，别用 `document_chunk` |
| 8 | pgvector 索引是 IVFFlat | 数据量大时检索变慢 | 超过 ~100 万 chunk 再换 HNSW（migration 里有注释好的 SQL） |

---

## 8. 用 SQL 亲手验证

**查一个知识库有没有向量成功写入：**

```sql
SELECT count(*) AS with_vector,
       (SELECT count(*) FROM "DocumentChunk" WHERE "embedding" IS NULL) AS without_vector
FROM "DocumentChunk";
```

**手动对一个 chunk 做向量检索（拿已存在的向量当 query）：**

```sql
SELECT dc."id", dc.content, dc."embedding" <=> (SELECT "embedding" FROM "DocumentChunk" WHERE "id" = '某个chunkId') AS distance
FROM "DocumentChunk" dc
ORDER BY distance
LIMIT 5;
```

**看文档状态机：**

```sql
SELECT "fileName", "status", "errorMessage" FROM "Document" ORDER BY "createdAt" DESC LIMIT 10;
```

---

## 9. 本篇小结

| 概念 | 一句话 |
|------|--------|
| **写入路** | 落盘 → 解析 → 切块 → 入库 → 向量化 → COMPLETED |
| **检索路** | 问题 → 向量化 → `<=>` 找最近 → 拼上下文 → 喂 LLM |
| **支持格式** | PDF（pdf-parse）、TXT/MD（readFile）；DOCX **未实现** |
| **切块** | chunkSize 1000 / overlap 200 |
| **向量化** | `EmbeddingService.embedBatch` 每批 100 条，用**知识库**配置的模型 |
| **写库** | `unnest($1, $2)` 一条 SQL 批量更新 embedding 列 |
| **向量检索** | `embedding <=> query` 余弦距离，`≤ threshold` 保留，升序取 topK |
| **关键词检索** | PostgreSQL `to_tsvector('simple') @@ plainto_tsquery` + `ts_rank` |
| **混合检索** | 两路并跑 + RRF `Σ 1/(60+rank+1)` 融合取 topK |
| **RAG 节点输出** | `【问题】...【知识库参考】[1]...` 文本，或 `json` 结构 |
| **Count 策略** | 增用 increment，删用重算 |
| **⚠️ 最大坑** | `embedding` 列 Prisma 不认识；embeddingModel/维度必须和模型一致 |

---

上一篇把前端五条链路串到底；下一篇是**全书收尾**：把全部 28 个接口逐字段列出 JSON 示例，前后端字段一一对照，顺便复核前面所有文档的准确性。

→ 打开 [`08-前后端数据对照总表.md`](./08-前后端数据对照总表.md)