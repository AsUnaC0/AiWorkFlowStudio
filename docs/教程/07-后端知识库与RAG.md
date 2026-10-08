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
         写入路（upload，★ 异步）                    检索路（rag）
用户上传《员工手册.pdf》                   用户问「报销标准多少？」
     │                                          │
     ▼                                          ▼
┌──────────────────┐                     ┌──────────────────┐
│ 落地磁盘 uploads/ │                     │ 你 → 一个问题      │
│ kb-uuid/xxx.pdf  │                     └────────┬─────────┘
└────────┬─────────┘                              ▼
         ▼                                  EmbeddingService
┌──────────────────┐                    nomic-embed-text → 768 维向量
│ 建 Document 记录  │                            ▼
│ status=UPLOADED  │                   VectorStoreService.vectorSearch
└────────┬─────────┘                 SQL: embedding <=> 你的向量 < 0.8
         │                                排最像的前 5
         │  queue.add('process-document')          ▼
         ▼  ══════ Redis ══════          命中文本拼成【知识库参考】
┌──────────────────┐ ← ─ ─ ─ ─ ─ ─┐      ┌──────────────────┐
│ DocumentProcessor│   后台 Worker │      │ RAG 节点输出：      │
│ （★ 异步段开始）  │   与 HTTP 无关 │      │【问题】...          │
└────────┬─────────┘ ← ─ ─ ─ ─ ─ ─┘      │【知识库参考】        │
         ▼                                    │[1] ... [2] ...      │
┌──────────────────┐   status=PROCESSING       └────────┬─────────┘
│ 解析成纯文本       │   pdf-parse 抽文字                 ▼
└────────┬─────────┘                    LLM 节点 systemPrompt 里用
         ▼                              {{rag_1.output}} → 结合资料回答
┌──────────────────┐
│ 切块 Recursive   │
│ chunkSize 100    │  ★ 本次从 1000 调小
│ chunkOverlap 50  │  ★ 本次从 200 调小
└────────┬─────────┘
         ▼
┌──────────────────┐
│ 批量 Embedding    │
│ 每批 100 条       │
└────────┬─────────┘
         ▼
┌──────────────────┐
│ unnest 批量写库    │  → status=COMPLETED
│ chunk.embedding   │     （失败 → FAILED + errorMessage）
└────────┬─────────┘
         ▼
   ┌───────────┐
   │  调 Ollama  │ ← 慢！几十秒
   └───────────┘
```

> **★ 为什么要拆成两段**：框起来的那一大块（解析→切块→向量化）**要调 Ollama，CPU 上可能几十秒**。
> 放在 HTTP 请求里会：① 浏览器一直转圈、② 反向代理超时断开、③ 用户刷新就白跑一次。
> 拆开后上传接口**毫秒级返回**，慢活儿交给后台，用户可以继续干别的，看进度就行。

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

## 4. ★ 写入路：上传一个 PDF 的完整流程（★ 现在是异步的）

上传分成**两段代码**，分居两个进程生命周期：

```
【同步段：HTTP 请求内，毫秒级】
documents.controller.ts upload()
  ① owner 校验 → ② 扩展名白名单 → ③ 落盘 → ④ 建记录(UPLOADED) → ⑤ queue.add() → ⑥ 返回 jobId

                        ↓  queue.add('process-document', {...})
                        ↓  Redis: bull:document-processing

【异步段：后台 Worker，与 HTTP 无关】
queues/document-processing/document.processor.ts process(job)
  ⑦ status=PROCESSING → ⑧ 解析 → ⑨ 切块入库 → ⑩ 批量 embedding → ⑪ 写 pgvector → ⑫ COMPLETED
                              ↓ 每步 job.updateProgress(10/30/50/80/100)
                              ↓ 任何一步抛错 → status=FAILED + errorMessage，然后 rethrow（BullMQ 记 failed）
```

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

> ⚠️ `FileInterceptor` 默认把文件读进**内存** `buffer`。50MB 上限下单机够用，
> 但严格说生产环境应该用磁盘型 `multer` storage，避免并发上传打爆内存。

### 4.2 同步段：Controller 只做 5 件事

```typescript
@Injectable()
export class DocumentsController {
  constructor(
    private readonly documentService: DocumentService,
    @InjectQueue('document-processing')            // ★ 注入队列
    private readonly documentQueue: Queue,
  ) {}
```

```typescript
async upload(user, kbId, file) {
  // ① 权限：必须是知识库 owner
  await this.documentService.assertKbOwner(user.id, kbId);
  if (!file) throw new HttpException('文件不能为空', 400);

  // ② 格式白名单（不是"能解析的全部格式"，而是"允许传的格式"）
  const ext = extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {         // .pdf .docx .txt .md .markdown
    throw new HttpException(`不支持的文件类型：${ext}...`, 400);
  }

  // ③ 落地磁盘：uploads/<kbId>/<documentId><ext>
  const documentId = crypto.randomUUID();
  const storageDir = join(UPLOAD_DIR, kbId);
  const storagePath = join(storageDir, `${documentId}${ext}`);
  await mkdir(storageDir, { recursive: true });
  await writeFile(storagePath, file.buffer);

  // ④ 建文档记录（状态 UPLOADED —— ★ 不是 PROCESSING，等 Worker 来改）
  const doc = await this.documentService.create({
    knowledgeBaseId: kbId,
    fileName: file.originalname,
    fileType: EXT_TO_TYPE[ext] ?? ext.replace('.', '').toUpperCase(),
    fileSize: file.size,
    storagePath,
    mimeType: file.mimetype,
    status: 'UPLOADED',
  });

  // ⑤ 入队 → DocumentProcessor 后台处理
  const job = await this.documentQueue.add(
    'process-document',                          // Job name
    { documentId: doc.id, knowledgeBaseId: kbId, storagePath },   // Job data
    {
      attempts: 3,                               // ★ 失败重试 3 次
      backoff: { type: 'exponential', delay: 3000 },   // 3s → 6s → 12s 递增
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  );

  // ⑥ 立刻返回（不再等解析）
  return {
    documentId: doc.id,
    jobId: job.id,
    status: 'UPLOADED',
    message: '文件已上传，正在后台处理',
  };
}
```

**返回值形状变了（重要）：**

```json
{ "documentId": "2a1...", "jobId": "3", "status": "UPLOADED", "message": "文件已上传，正在后台处理" }
```

> ✅ **前端类型已改对（★ 本次修）**：`api/knowledge.ts` 现在有独立的 `UploadDocumentResult` 接口：
>
> ```typescript
> /** uploadDocument 返回 —— 后端入队后立即返回（异步处理中） */
> export interface UploadDocumentResult {
>   documentId: string;
>   jobId: string;
>   status: "UPLOADED";
>   message: string;
> }
>
> export const uploadDocument = async (kbId: string, file: File): Promise<UploadDocumentResult> => { ... }
> ```
>
> `detail.vue` 依然是 `await uploadDocument(...)` 不接返回值（靠 2s 轮询刷列表），
> 现在也补了 `getDocument(id)` 可以按 id 单独查（页面还没用）。

### 4.3 ★ 异步段：`DocumentProcessor` 逐行拆

文件：`backend/src/queues/document-processing/document.processor.ts`

```typescript
export interface ProcessDocumentJobData {
  documentId: string;
  knowledgeBaseId: string;
  storagePath: string;
}

@Processor('document-processing')
export class DocumentProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentParserService: DocumentParserService,   // ← 来自 KnowledgeModule exports
    private readonly chunkService: ChunkService,                      // ← 同上
    private readonly embeddingService: EmbeddingService,
    private readonly vectorStoreService: VectorStoreService,
  ) { super(); }

  async process(job: Job<ProcessDocumentJobData>): Promise<any> {
    if (job.name !== 'process-document') return undefined;

    const { documentId, knowledgeBaseId, storagePath } = job.data;

    // ① 改成「处理中」
    await this.prisma.document.update({
      where: { id: documentId },
      data: { status: 'PROCESSING' },
    });

    try {
      // ① ★ 幂等保护：重试时先清理上一次残留的 chunks
      const existingCount = await this.prisma.documentChunk.count({
        where: { documentId },
      });
      if (existingCount > 0) {
        await this.prisma.$transaction(async (tx) => {
          await tx.documentChunk.deleteMany({ where: { documentId } });
          await tx.knowledgeBase.update({
            where: { id: knowledgeBaseId },
            data: { chunkCount: { decrement: existingCount } },
          });
        });
      }

      await job.updateProgress(10);                    // 10%

      // ② 解析 → 纯文本
      const text = await this.documentParserService.parse(storagePath);

      await job.updateProgress(30);                    // 30%

      // ③ 分块 → 入库（同时 increment 知识库的 chunkCount）
      const chunks = await this.chunkService.split(text);
      await this.chunkService.createMany(documentId, knowledgeBaseId, chunks);

      await job.updateProgress(50);                    // 50%

      // ④ 取刚写入的 chunk（此时 embedding 全是 null）
      const storedChunks = await this.prisma.documentChunk.findMany({
        where: { documentId },
        select: { id: true, content: true },
      });

      // ⑤ 查知识库 embeddingModel 配置
      const kb = await this.prisma.knowledgeBase.findUnique({
        where: { id: knowledgeBaseId },
        select: { embeddingModel: true },
      });
      if (!kb) throw new Error('知识库不存在');

      // ⑥ 批量向量化
      if (storedChunks.length > 0) {
        const vectors = await this.embeddingService.embedBatch(
          storedChunks.map((c) => c.content),
          kb.embeddingModel,                           // ★ 用知识库配置的模型
        );
        await job.updateProgress(80);                  // 80%

        // ⑦ 批量写 pgvector（一条 SQL，unnest）
        const pairs = storedChunks.map((c, i) => ({ chunkId: c.id, vector: vectors[i] }));
        await this.vectorStoreService.updateEmbeddingBatch(pairs);
      }

      await job.updateProgress(100);                   // 100%

      // ⑧ 成功 → COMPLETED
      await this.prisma.document.update({
        where: { id: documentId },
        data: { status: 'COMPLETED' },
      });

      return { documentId, chunkCount: chunks.length };
    } catch (error) {
      // ⑨ 失败 → FAILED + 错误消息（★ 注意：写库用 prisma，不是 documentService）
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.document.update({
        where: { id: documentId },
        data: { status: 'FAILED', errorMessage: message },
      });
      throw error;                                     // ★ 必须 rethrow，BullMQ 才知道这任务失败了
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) { console.log(`[DocumentProcessor] Job ${job.id} completed for document ${job.data?.documentId}`); }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    console.error(`[DocumentProcessor] Job ${job.id} failed for document ${job.data?.documentId}:`, error.message);
  }
}
```

**几个值得注意的点：**

| 点 | 说明 |
|----|------|
| **状态机现在是 4 态** | `UPLOADED`（入队接口写）→ `PROCESSING`（Worker 开始）→ `COMPLETED` / `FAILED` |
| **HTTP 不再返回 500** | ★ 解析失败**不会**让上传请求报错。要看结果得查文档列表的 `status` 和 `errorMessage` |
| **`throw error` 不能省** | 漏了它，BullMQ 会认为任务成功，`attempts` 重试和 `failed` 事件都不会触发 |
| **`updateProgress`** | 让前端能显示进度条（但目前前端没接 `QueueEvents`，只是本地 fake 进度） |
| **`attempts: 3` + 指数退避** | 3s → 6s → 12s。适合「Ollama 偶发超时」这种瞬时故障 |
| **embeddingModel 从哪来** | 知识库记录！**不能用节点里的模型**，否则维度对不上 |
| **先入库再更新向量** | 因为 Prisma 只能插非 embedding 列，所以先 `createMany` 再裸 `UPDATE` |
| **重复执行会重复插入 chunk**（已修） | ⚠️ 原来 `createMany` 前不删旧 chunk，`attempts: 3` 重投会插入重复 chunk 并重复 `increment chunkCount`。**现在 `process()` 开头加了幂等保护**：`count` 出残留量 → `$transaction` 里 `deleteMany` + `decrement chunkCount` |
| **幂等保护为什么放最前面** | 必须赶在 `createMany` 之前，而且要和「回退 `chunkCount`」放同一个 `$transaction`，否则删成功但计数回退失败就永久对不上 |

### 4.4 前端怎么跟进状态（轮询）

`views/knowledge/detail.vue` 里：

```typescript
/** 启动状态轮询：有 UPLOADED/PROCESSING 状态的文档时每 2s 刷新 */
onMounted(() => {
  // ...
  (d) => d.status === "UPLOADED" || d.status === "PROCESSING",
});
```

对应 UI 映射（`statusMap`）：

| 后端 status | 页面显示 | 主题色 | 进度条 |
|------------|---------|--------|--------|
| `UPLOADED` | 已上传 | default | 无 |
| `PROCESSING` | 处理中 | primary | `t-progress :percentage="60"`（假进度） |
| `COMPLETED` | 已完成 | success | 无 |
| `FAILED` | 失败 | danger | 无（显示 `errorMessage`） |

> ℹ️ 页面底部还有一条提示：只要存在 `UPLOADED`/`PROCESSING` 的文档就显示「处理中」提示条。

### 4.5 四种解析器

| 类型 | 实现 | 现有状态 |
|------|------|---------|
| PDF | `pdf-parse` | ✅ 可用 |
| TXT / MD | 直接 `readFile(utf-8)` | ✅ 可用 |
| DOCX | `throw new Error('DOCX 解析尚未实现')` | ❌ **会转 FAILED** |

> **⚠️ 上传 `.docx` 一定会转 FAILED**（解析器没实现）。表单允许传 docx，但处理必挂。
> **异步化之后这个错误「更隐蔽」了**：以前上传请求直接返回 500，你立刻知道；现在上传成功返回 201，
> 要等 Worker 跑完（很快，因为是同步 throw）才在文档列表看到 `FAILED` + `errorMessage`。
> 想补的话用 `mammoth` 之类库替换 `DocxParser.parse` 即可。

### 4.6 切块参数 `ChunkService`

```typescript
private readonly splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 100,        // ★ 每块约 100 字符（旧版是 1000，本次调小了）
  chunkOverlap: 50,      // ★ 相邻块重叠 50 字符（旧版是 200）
});
```

**chunkOverlap 为什么不设 0？** 防止一句话/表格在块边界被切断。
检索回到第 2 块时，如果不知道前文，可能需要第 1 块的尾巴。重叠 50 字符保住上下文。

> ⚠️ **注意切块参数本次被调小了**：从 `1000/200` 改成了 `100/50`。
> **影响**：同样的文档会产生**约 10 倍数量**的 chunk，`chunkCount` 涨得更快，
> 向量化耗时和 pgvector 存储也成倍增加（但检索粒度更细、召回更准）。
> 这是本地调试取向（`nomic-embed-text` 在 CPU 上很慢，切小了能快速看到结果）。
> **上生产记得调回去**，比如 `800/100`。

**`createMany` 顺手做的事**（事务里）：

```typescript
await this.chunkService.createMany(documentId, knowledgeBaseId, chunks);
// → 事务：createMany 插 chunk + knowledgeBase.chunkCount += created.count
```

### 4.7 批量向量化 `EmbeddingService`

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

### 4.8 ★ 批量写向量：一次 UPDATE 100 个 chunk

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

### 5.1 三种检索模式总览（`KnowledgeRetrievalService` → `VectorStoreService`）

> **两个服务的分工**：`KnowledgeRetrievalService`（`knowledge/retrieval/`）是**统一检索入口**，按 `mode` 路由到 vector / keyword / hybrid，并负责「查询向量化 + 相似度阈值换算」；真正写 SQL 的是底层 `VectorStoreService`（`knowledge/vector/`）。RAG 节点、Agent 的知识库工具都只依赖上层入口。
>
> 入口签名：`search({ knowledgeBaseIds, query, mode?, topK?, embeddingModel?, scoreThreshold? })`，返回统一的 `SearchResult[]`（`score` 语义为**越大越相似**）。

| 模式 | 检索 SQL 核心 | 适合 |
|------|--------------|------|
| **vector** | `embedding <=> query` 余弦距离 | 语义相近但字面不同的提问 |
| **keyword** | PostgreSQL `to_tsvector` 全文检索 | 精确名词（型号、人名、专有名词） |
| **hybrid** | 两路并跑 + RRF 融合 | ★ 日常推荐（默认） |

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
| 1 | `embeddingModel` 填错或维度填错 | **后台任务**报 `expected 768 dimensions, not 1024`，文档转 `FAILED` | 建库就填对；检索报维度错先查这个 |
| 2 | DOCX 解析未实现 | 传 docx → **上传返回 201，但后台任务失败** → 文档 `FAILED` | 用 `mammoth` 补 `DocxParser` |
| ~~3~~ | ~~Chat 页 `knowledgeBaseIds` 被无视~~ **已修** | — | ✅ Chat 页改成 Agent，通过 Knowledge 工具走统一检索；`/ai/chat` 本身仍不带知识库 |
| ~~4~~ | ~~`KnowledgeRetrievalService` 是半成品~~ **已实现** | — | ✅ 现在按 `mode` 路由到 `vector` / `keyword` / `hybrid`（RRF，`rrfK=60`），底层调 `VectorStoreService` + `EmbeddingService`，不再 `throw` |
| 5 | ~~上传是同步的~~ | ✅ **已解决**：现在走 `document-processing` 队列，接口毫秒级返回 | —— |
| 6 | `pageCount`、`tokenCount` 字段声明了但不赋值 | 永远 null | 真用的时候再补逻辑 |
| 7 | 原始 SQL 里表名大小写 | `"DocumentChunk"` 双引号区分大小写 | 写 SQL 时保持一致，别用 `document_chunk` |
| 8 | pgvector 索引是 IVFFlat | 数据量大时检索变慢 | 超过 ~100 万 chunk 再换 HNSW（migration 里有注释好的 SQL） |
| ~~9~~ | ~~★ **前端 `uploadDocument` 返回类型是错的**~~ **已修** | — | ✅ 新增 `UploadDocumentResult` 接口，`uploadDocument` 返回类型改对；顺带补了 `getDocument(id)` |
| ~~10~~ | ~~★ **`attempts: 3` 重试会插入重复 chunk**~~ **已修** | — | ✅ `process()` 开头加幂等保护：`count` → `$transaction`(`deleteMany` + `decrement chunkCount`) |
| 11 | ★ **切块参数被调到 `100/50`** | 同文档 chunk 数涨约 10 倍，CPU 上向量化极慢 | 本地调试够用；上生产改回 `800/100` |
| 12 | ★ **失败原因不再 HTTP 报错** | 传 docx / 维度错都返回 201，只能靠查列表看 `errorMessage` | 前端轮询时把 `FAILED` + `errorMessage` 弹给用户 |
| 13 | ★ **`document.service.ts` 的 `updateStatus` 成了死代码** | 异步化后 Processor 直接用 `prisma.document.update`，没人调它 | 可以删，或让 Processor 改用它 |
| 14 | ★ **幂等保护只清了 chunk，没清向量** | 删的是 `DocumentChunk` 行（向量跟着行一起没），但如果以后把向量存到外部服务（Qdrant / Milvus）就漏了 | 目前向量在 pgvector 里所以安全；换外部向量库时这里要一起清 |
| 15 | ★ **进度条是假的** | 页面写死 `percentage="60"`；`job.updateProgress(10/30/50/80/100)` 的真值没出口给前端 | 要接 `QueueEvents` + SSE，或让 `getDocument` 返回进度字段 |

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
| **写入路（两段）** | 同步段：落盘 → 建记录(`UPLOADED`) → 入队；异步段：解析 → 切块 → 入库 → 向量化 → `COMPLETED` |
| **检索路** | 问题 → 向量化 → `<=>` 找最近 → 拼上下文 → 喂 LLM |
| **★ 队列** | `document-processing`；Processor 在 `queues/document-processing/document.processor.ts` |
| **★ 重试** | `attempts: 3` + 指数退避（3s/6s/12s）；失败必须 `throw` 出去 BullMQ 才知道 |
| **★ 幂等保护** | `process()` 开头：`count` 残留 chunk → `$transaction`(`deleteMany` + `decrement chunkCount`)，重投不会重复插入 |
| **状态机（4 态）** | `UPLOADED`（接口写）→ `PROCESSING`（Worker）→ `COMPLETED` / `FAILED` |
| **前端跟进** | `detail.vue` 每 2s 轮询文档列表，有 `UPLOADED`/`PROCESSING` 就刷 |
| **支持格式** | PDF（pdf-parse）、TXT/MD（readFile）；DOCX **未实现** |
| **切块** | ★ chunkSize **100** / overlap **50**（旧版 1000/200，本次调小） |
| **向量化** | `EmbeddingService.embedBatch` 每批 100 条，用**知识库**配置的模型 |
| **写库** | `unnest($1, $2)` 一条 SQL 批量更新 embedding 列 |
| **向量检索** | `embedding <=> query` 余弦距离，`≤ threshold` 保留，升序取 topK |
| **关键词检索** | PostgreSQL `to_tsvector('simple') @@ plainto_tsquery` + `ts_rank` |
| **混合检索** | 两路并跑 + RRF `Σ 1/(60+rank+1)` 融合取 topK |
| **RAG 节点输出** | `【问题】...【知识库参考】[1]...` 文本，或 `json` 结构 |
| **Count 策略** | 增用 increment，删用重算 |
| **⚠️ 最大坑** | `embedding` 列 Prisma 不认识；embeddingModel/维度必须和模型一致；**异步化后失败不再 HTTP 报错** |

---

上一篇把前端五条链路串到底；下一篇是**全书收尾**：把全部 58 个接口逐字段列出 JSON 示例，前后端字段一一对照，顺便复核前面所有文档的准确性。

→ 打开 [`08-前后端数据对照总表.md`](./08-前后端数据对照总表.md)