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
│ Storage 落盘     │                     │ 你 → 一个问题      │
│ (local / qiniu)  │                     └────────┬─────────┘
└────────┬─────────┘                              ▼
         ▼                                  EmbeddingService
┌──────────────────┐                    nomic-embed-text → 768 维向量
│ 建 Document 记录  │                            ▼
│ status=UPLOADED  │                   VectorStoreService.vectorSearch
└────────┬─────────┘        SQL: embedding <=> 你的向量 < 0.8（距离）
                            ↑ 由 RAG 节点 threshold=0.2（相似度）换算而来
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
├── embeddingModel     "nomic-embed-text"      ← ★ 现在只是「展示用元数据」，由激活版本同步写入
├── embeddingDimension 768                      ← ★ 同上，不再是检索依据
├── documentCount      冗余计数
└── chunkCount         冗余计数
        │ 1:N
        ▼
Document（一篇文档）
├── fileName / fileType / fileSize
├── storagePath        ← 存储位置（local=磁盘路径 / qiniu=对象 key，见附录 09）
├── status             UPLOADED → PROCESSING → COMPLETED / FAILED
└── errorMessage       FAILED 的原因
        │ 1:N
        ▼
DocumentChunk（一个文本块）  ← ★ 只存文本，不再存向量
├── content            ← 切出来的~1000字符文本
└── chunkIndex         ← 第几块

        ╎ 1:N（★ 本次新增：向量版本化）
        ▼
KnowledgeBaseEmbeddingVersion（某知识库的一个向量版本）
├── modelId / llmModelId   ← 用什么模型生成的
├── dimensions             ← 该版本的向量维度（768 / 1024 / 1536 …）
├── vectorTable            ← "EmbeddingVector_<uuid>" ← 物理表名，每个版本一张
├── status                 ← PENDING | PROCESSING | READY | FAILED | ARCHIVED
├── isActive               ← 是否为该库的生效版本（同一库只有一个 true）
└── chunkTotal / chunkDone / chunkFailed   ← 向量化进度
        │ 1:N
        ▼
DocumentChunkEmbedding（★ 只记状态，不存向量）
├── chunkId / embeddingVersionId
└── status   PENDING | DONE | FAILED（+ error 原因）
```

**最关键的三句**：

1. `DocumentChunk` **不再存向量**。向量按「版本」存在各自独立的物理表 `EmbeddingVector_<uuid>` 里，
   列是 `vector(该版本 dimensions)` + HNSW 索引。
2. **真正的检索依据是「生效版本」**（`isActive = true`），不是 `KnowledgeBase.embeddingModel`。
   `DocumentChunk.embedding` 这个老列（`vector(768)`）只在「该库还没建过版本」时作兼容回退。
3. 所有向量的读写都是**裸 SQL**（`VectorStoreService`），Prisma 客户端读不了 `vector` 类型。

> **为什么一个版本一张表**：pgvector 的 HNSW / IVFFlat 索引**只能建在有固定维度的 `vector(N)` 列上**。
> 换 Embedding 模型必然换维度，共用一个列就装不下。详见 **§4.10**。

---

## 3. 知识库 CRUD（接口+权限）

`knowledge.controller.ts`，整个 Controller 加了 `@UseGuards(JwtAuthGuard)`。

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| POST | `/knowledge-bases` | 登录即可 | 建库，`ownerId = 当前用户` |
| GET | `/knowledge-bases` | 登录即可 | 只列 `ownerId = 我` 的库 |
| GET | `/knowledge-bases/:id` | **owner** | 404 不存在 / 403 不是我的 |
| PUT | `/knowledge-bases/:id` | **owner** | 更新 |
| DELETE | `/knowledge-bases/:id` | **owner** | 删库（级联删文档+chunks；删除前按 `storagePath` 逐个清本地文件 / 七牛对象，见下方） |
| GET | `/workspaces/:wsId/knowledge-bases` | workspace member | 该空间关联的库 |
| POST | `/workspaces/:wsId/knowledge-bases/:kbId` | **workspace member 且 kb owner** | 关联到空间 |
| DELETE | `/workspaces/:wsId/knowledge-bases/:kbId` | workspace member | 解绑 |

> ### ✅ 已修复：删知识库按 `storagePath` 逐个清文件（local / qiniu 都清理）
>
> 旧实现用 `fs.rm(join(UPLOAD_DIR, id))` 删 `uploads/<kbId>` 目录，但文档实际上传落盘在：
> ```typescript
> // storage.service.ts（uploadLocal）—— subDir 是调用方传的，知识库文档传的是 documents/${kbId}
> join(uploadDir, subDir, `${randomUUID()}${ext}`)          // uploads/documents/<kbId>/<uuid>.pdf  （local）
> // uploadQiniu —— 对象 key 同样带 subDir
> `${subDir}/${datePath}/${randomUUID()}${ext}`            // documents/<kbId>/<date>/<uuid>.pdf  （qiniu 对象 key）
> ```
> 路径对不上，且 `fs.rm` 根本不会碰七牛云，**local 残留目录、qiniu 残留对象**。
>
> 现 `knowledge.service.ts` 的 `remove()` 改成：
> ```typescript
> // 1) 先取出该库全部文档的存储路径（DB 记录级联删除后就拿不到了）
> const docs = await this.prisma.document.findMany({
>   where: { knowledgeBaseId: id },
>   select: { storagePath: true },
> });
> // 2) 逐个调 StorageService.delete()：local→unlink，qiniu→删对象
> await Promise.all(docs.map((d) => this.storageService.delete(d.storagePath).catch(...)));
> // 3) 再级联删 KnowledgeBase（documents / chunks / links 一并删）
> return this.prisma.knowledgeBase.delete({ where: { id }, select: kbSelection });
> ```
> 因为用的是库里存的 `storagePath`（而非拼接目录），**两种存储模式都能删干净**，且与「删单个文档」走同一套 `StorageService`，行为一致。

**创建接口的 DTO：**

```typescript
export class CreateKnowledgeBaseDto {
  @IsString() @IsNotEmpty() @MaxLength(200) name: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsString() @IsNotEmpty() @MaxLength(100) embeddingModel: string;
  @IsInt() @Min(1) @Max(8192) embeddingDimension: number;
  /** ★ 关联用户在「模型管理」中添加的 Embedding 模型 id（优先于 embeddingModel） */
  @IsOptional() @IsString() @MaxLength(100) embeddingLlmModelId?: string;
}
```

前端默认提交 `embeddingModel: "nomic-embed-text"`、`embeddingDimension: 768`。
**这是一对容易配错的参数**：必须和 Ollama 里真实存在的模型、模型真实输出维度一致（第 5 节讲症状）。

> **★ 新增的 `embeddingLlmModelId` 是什么？**
> 它是第 10 篇「模型管理」的产物：如果用户在 `/providers` 里配了一个云端 Embedding 模型（比如某家的 `bge-large`），
> 就能在这里填上它的 id，**建库时用云端模型算向量，而不用本地 Ollama**。
>
> 两个字段是**二选一、前者优先**：
> - 传了 `embeddingLlmModelId` → 走 `LlmConfigService.resolveModelRuntime()`，用用户的 Provider + 真实模型名；
> - 没传（`null`）→ 回退到全局 Ollama + `embeddingModel` 字段。
>
> ⚠️ **建库用哪个模型，检索时就必须用哪个模型**——向量是模型特有的，混用会检索出乱七八糟的结果。
> 所以检索时（§4.7 / §5）后端会**优先取知识库绑定的 `embeddingLlmModelId`**，保证和写入时一致。

**删除会清掉底层存储文件（两种删，现已一致）：**

```typescript
// 删知识库（knowledge.service.remove）：先按 storagePath 逐个删文件，再级联删 DB 记录
const docs = await this.prisma.document.findMany({
  where: { knowledgeBaseId: id }, select: { storagePath: true },
});
await Promise.all(docs.map((d) => this.storageService.delete(d.storagePath)));
return this.prisma.knowledgeBase.delete({ ... });   // documents / chunks / links 级联删

// 删单个文档（document.service.remove）：先删文件（StorageService 自动 local/qiniu），再删记录，然后重算两个计数
await this.storageService.delete(doc.storagePath);        // local→unlink；qiniu→删对象
await this.prisma.document.delete({ where: { id } });
const [documentCount, chunkCount] = await Promise.all([  // ★ 删除时重算，保证准确
  this.prisma.document.count({ ... }),
  this.prisma.documentChunk.count({ ... }),
]);
await this.prisma.knowledgeBase.update({ data: { documentCount, chunkCount } });
```

> 删知识库与删单个文档**都通过 `StorageService.delete()` 清底层文件**：local 模式 `unlink` 真实绝对路径，qiniu 模式删除七牛对象。**两种存储模式都能删干净**，不再有「删库不删七牛对象」的问题（详见附录 09 坑⑦）。

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
    private readonly storageService: StorageService,         // ★ 统一存储（local / 七牛云）
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

  // ③ 交给 StorageService 落盘（本地磁盘 / 七牛云 自动切换，见附录 09）
  const uploaded = await this.storageService.upload(
    file.buffer,
    file.originalname,
    `documents/${kbId}`,
  );

  // ④ 建文档记录（状态 UPLOADED —— ★ 不是 PROCESSING，等 Worker 来改）
  const doc = await this.documentService.create({
    knowledgeBaseId: kbId,
    fileName: file.originalname,
    fileType: EXT_TO_TYPE[ext] ?? ext.replace('.', '').toUpperCase(),
    fileSize: uploaded.size,
    storagePath: uploaded.key,        // ★ local=绝对路径；qiniu=对象 key
    mimeType: file.mimetype,
    status: 'UPLOADED',
  });

  // ⑤ 入队 → DocumentProcessor 后台处理
  const job = await this.documentQueue.add(
    'process-document',                          // Job name
    { documentId: doc.id, knowledgeBaseId: kbId, storagePath: uploaded.key },   // Job data
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
    private readonly storageService: StorageService,                 // ★ 统一存储（local / 七牛云）
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

      // ② 解析 → 纯文本（★ 七牛模式：对象先下载到系统临时目录再解析，见附录 09）
      let localPath = storagePath;
      if (this.storageService.type === 'qiniu') {
        localPath = await this.storageService.getLocalPath(storagePath);
      }
      const text = await this.documentParserService.parse(localPath);

      // ②.5 ★ 空文本预检：扫描件 / 图片型 PDF 提不出文字 → 直接 FAILED（给 OCR 提示）
      //      不静默标记 COMPLETED，避免用户误以为向量化成功
      if (!hasTextContent(text)) {
        throw new Error('未能从该文件中提取到有效文本内容（可能是扫描件或图片型 PDF，需先做 OCR）');
      }

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

      // ⑤ ★ 取该知识库的「生效向量版本」（没有会按 KB 配置自动建 v1 并激活）
      const activeVersion =
        await this.versionService.ensureActiveVersion(knowledgeBaseId);

      // ⑥ 批量向量化 —— ★ 用生效版本的模型，而不是 kb.embeddingModel
      if (storedChunks.length > 0) {
        const vectors = await this.embeddingService.embedBatch(
          storedChunks.map((c) => c.content),
          activeVersion.modelId,                       // ★ 生效版本的模型
          activeVersion.llmModelId,
          telemetry,
        );

        // ⑥.5 ★ 整批前置维度校验：vectors[0].length !== 生效版本.dimensions → 直接 throw
        //      （整篇文档 FAILED，错误消息是中文可操作提示；writeVectors() 内的逐条 FAILED 只是兜底）
        const dim = vectors[0]?.length;
        if (dim !== undefined && dim !== activeVersion.dimensions) {
          throw new Error(
            `Embedding 维度不匹配：激活版本「${activeVersion.modelId}」输出 ${dim} 维，` +
              `但该知识库当前向量版本为 ${activeVersion.dimensions} 维。` +
              `请到知识库设置里用「切换向量模型」建立新版本并重新向量化，不要直接改配置。`,
          );
        }

        await job.updateProgress(80);                  // 80%

        // ⑦ ★ 写入版本专属物理表（writeVectors 内部逐条兜底校验，不符的记 FAILED 不中断整批）
        const pairs = storedChunks.map((c, i) => ({ chunkId: c.id, vector: vectors[i] }));
        await this.versionService.writeVectors(activeVersion.id, pairs);
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
| **★ embeddingModel 从哪来** | **不再是** `kb.embeddingModel`！现在是 `EmbeddingVersionService.ensureActiveVersion(kbId)` 返回的**生效版本**的 `modelId` / `llmModelId`。用错模型 = 向量空间不一致 = 检索精度归零 |
| **★ 先入库再更新向量** | 因为 Prisma 只能插非 vector 列，所以先 `createMany` 写文本块，再写版本物理表 |
| **重复执行会重复插入 chunk**（已修） | ⚠️ 原来 `createMany` 前不删旧 chunk，`attempts: 3` 重投会插入重复 chunk 并重复 `increment chunkCount`。**现在 `process()` 开头加了幂等保护**：`count` 出残留量 → `$transaction` 里 `deleteMany` + `decrement chunkCount` |
| **幂等保护为什么放最前面** | 必须赶在 `createMany` 之前，而且要和「回退 `chunkCount`」放同一个 `$transaction`，否则删成功但计数回退失败就永久对不上 |
| **`storagePath` 有两种语义**（★ 新增） | `local` = 绝对路径；`qiniu` = 对象 key。`process()` 开头会先 `getLocalPath` 转成可解析的本地路径，并在 `finally` 里 `unlink` 掉临时文件 |

> **七牛云 / 对象存储？** 传文件不一定要落本地磁盘——`STORAGE_TYPE=qiniu` 会把文件丢到七牛云对象存储，
> 上传、解析、删除的代码都走同一个 `StorageService` 自动切换。私有空间 401、签名 URL 裸地址等**踩坑合集**见 **附录 09**。

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
async embedBatch(
  texts: string[],
  model: string,                        // 本地 Ollama embedding 模型名（回退用）
  llmModelId?: string | null,           // ★ 用户在「模型管理」里加的 Embedding 模型 id
): Promise<number[][]> {
  let backend: AiProvider = this.aiService.getProvider();   // 默认全局 Ollama
  let modelName = model;
  if (llmModelId) {                                          // ★ 传了就换成用户的 Provider
    const runtime = await this.llmConfigService.resolveModelRuntime(llmModelId);
    backend = runtime.provider;
    modelName = runtime.modelId;
  }

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {      // 每批 100 条
    const batch = texts.slice(i, i + BATCH_SIZE);
    const result = await backend.embedding(batch, { model: modelName });
    allVectors.push(...result.embeddings);
  }
}
```

**调用方**（`document.processor.ts`）会把知识库的两个字段都读出来传进去——这就是「建库用哪个模型、向量化就用哪个模型」的保证：

```typescript
// ★ 本次升级后：模型来自「生效向量版本」，不再直接读 kb 的两个字段
const activeVersion =
  await this.versionService.ensureActiveVersion(knowledgeBaseId);
const vectors = await this.embeddingService.embedBatch(
  storedChunks.map((c) => c.content),
  activeVersion.modelId,       // 生效版本的模型
  activeVersion.llmModelId,    // 有自定义模型就用它，没有 → null → 回退 Ollama
  telemetry,
);
```

- 交给 `AIService` → Ollama **`/api/embeddings`**（⚠️ 旧文档写的 `/api/embed` 是错的，少了结尾的 `s`）
- **一批 100 条**，防止单次请求体太大
- `model` 必须和**该版本当初生成向量时用的一致**，否则向量空间不同，检索就没意义
- ★ **维度校验**：向量化后**逐条**检查维度，不匹配的 chunk 单独标记 `FAILED` 并记原因（见下）

> **★ 维度校验有两层（别只记一层）**
>
> 1. **整批前置校验**（`document.processor.ts`，`embedBatch()` 之后、`writeVectors()` 之前）：
>    `vectors[0].length !== activeVersion.dimensions` → **直接 throw，整篇文档 FAILED**，
>    错误消息是中文可操作提示（「请到知识库设置里用『切换向量模型』建立新版本并重新向量化」）。
>    这是**主校验**——维度整体不对说明配错了模型，整篇重跑没意义。
> 2. **逐条兜底校验**（`EmbeddingVersionService.writeVectors()`）：个别条目不匹配时
>    只把该 chunk 记 `FAILED`，不中断整批，可单独重试。
>
> ```typescript
> // writeVectors() 内部：以生效版本的 dimensions 为准，逐条判定，不中断整批
> for (const { chunkId, vector } of pairs) {
>   if (!Array.isArray(vector) || vector.length !== version.dimensions) {
>     // → DocumentChunkEmbedding.status = 'FAILED'，error 记「期望 N 维，实际 X 维」
>     continue;
>   }
>   // → 写入 "EmbeddingVector_<versionId>"，状态置 DONE
> }
> ```
> 好处：768 不再是硬编码常量，**换 1024 / 1536 维的云端模型也不会整批炸**（只要版本维度配置正确），
> 只是个别不匹配的块被标记失败，可以单独重试（见 §4.10）。

> **⚠️ 「一批 100 条」≠ 一次请求**：`ollama.provider.ts:135-155` 的实际实现是
> ```typescript
> const embeddings: number[][] = [];
> for (const text of texts) {                       // ★ 逐条循环
>   const response = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {...});
>   embeddings.push(data.embedding);
> }
> return { embeddings, model };
> ```
> **Ollama 没有批量 embeddings 接口**，只能一条一条请求。
> 所以 `BATCH_SIZE = 100` 只是把大任务**分成若干组**避免内存峰值，**并没有减少 HTTP 请求次数**——
> 1000 个 chunk 就是 1000 次 HTTP 往返。这是「上传大文档慢」的主要原因之一。
> 想加速的话，可以改成 `Promise.all` 并发（注意限流）或换支持批量的 embedding 服务（如用户自配的云端模型）。

### 4.8 ★ 批量写向量

**当前主路径**：写进版本专属物理表（`EmbeddingVersionService.writeVectors()`）：

```sql
INSERT INTO "EmbeddingVector_<versionId>" ("chunkId", "embedding")
VALUES ($1::text, $2::vector)
ON CONFLICT ("chunkId") DO UPDATE SET "embedding" = EXCLUDED."embedding"
```

写入前**逐条**比对 `vector.length === version.dimensions`，不符的登记 `FAILED` + 原因，不中断整批。

**旧路径（仅兼容回退，库里还没有任何向量版本时才走）** —— 一次 UPDATE 100 个 chunk，
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

### 4.9 ★ 为什么 `embedding` 列非要手写？它到底干嘛的？

**① 它是干嘛的** —— 给「语义」一个可计算的形式：

- 每个文本块编码成 **N 个浮点数**（`nomic-embed-text` 是 768，`bge-m3` 是 1024，
  `text-embedding-3-small` 是 1536），这串数就是它在「语义空间」里的坐标
- 你问一个问题，问题也被编码成**同样 N 个数**（★ 必须用同一个模型，见 §5.1.1）
- pgvector 用 **`<=>` 余弦距离**算「问题坐标」和「每个块坐标」离得多近，最近的就是答案候选
- 没有它，检索只能靠关键词；有了它，**换个说法也能命中**（「业绩怎么算」和「KPI 定义」语义相近）

**② 为什么这列在 Prisma 里长得很奇怪** —— 因为 Prisma 原生不认识 PostgreSQL 的 `vector` 类型：

```prisma
model DocumentChunk {
  ...
  embedding   Unsupported("vector(768)")?   // ← Unsupported = 「这列存在，但我不管它」
}
// ★ 本次新增：每个向量版本一张物理表，维度由版本决定（运行时 CREATE TABLE，不在 schema 里）
//    CREATE TABLE "EmbeddingVector_<versionId>" (
//      "chunkId"   text PRIMARY KEY,
//      "embedding" vector(<dimensions>)
//    );
//    CREATE INDEX ... USING hnsw ("embedding" vector_cosine_ops);
```

| 什么操作 | Prisma 会怎样 |
|--------|--------------|
| `migrate dev` 之前（schema 没声明时） | 把这列当「多余列」，**生成 DROP COLUMN** → 检索直接报 `column "embedding" ... does not exist` |
| `migrate dev` 现在（声明了 `Unsupported`） | 不再 DROP 这列；但仍可能生成 `DROP INDEX "dc_embedding_ivf"`（索引类型 Prisma 声明不了） |
| `findMany()` / `create()` | 客户端类型里没有这个字段，**读写不了**，只能裸 SQL |

**③ 所以工程上要守三条规矩**：

1. `embedding` 列 + IVFFlat 索引必须由**手写 migration** 维护，且全用 `IF NOT EXISTS`（可重复执行）
2. 每次 `prisma migrate dev` 后**检查生成的 SQL**，发现 `DROP INDEX "dc_embedding_ivf"` 就删掉那句；
   真丢了索引，重跑恢复迁移里的 `CREATE ... IF NOT EXISTS` 就行
3. 所有向量的读写收敛在 `VectorStoreService` 一个文件里（`updateEmbeddingBatch` / `search`），
   别让裸 SQL 散落各处

> 这一整套（误删事故 + 修复）的来龙去脉见 **第 1 篇 §5.2**，这里只讲「为什么」。

### 4.10 ★ 向量版本化：怎么安全地换 Embedding 模型（本次新增）

**问题**：`DocumentChunk.embedding` 是 `vector(768)`。
你把知识库的 `embeddingDimension` 改成 1024，只是改了个元数据——
列还是 768 维，新向量根本写不进去，老向量也没重新生成，**检索会静默错乱**。
而 pgvector 的 HNSW/IVFFlat 索引又**只能建在固定维度的 `vector(N)` 上**，不能建在无维度列上。

**解法**：文本块与向量解耦，**一个版本一张物理表**。

```
DocumentChunk（文本块，解析一次永久复用）
    ├── EmbeddingVector_<v1>  vector(768)  + HNSW   ← nomic-embed-text  [isActive]
    ├── EmbeddingVector_<v2>  vector(1024) + HNSW   ← bge-m3           [READY，待激活]
    └── EmbeddingVector_<v3>  vector(1536) + HNSW   ← text-embedding-3-small
```

**完整流程（前端：知识库详情页「向量模型配置」区）**：

| 步骤 | 做什么 | 接口 |
|---|---|---|
| 1 | 模型管理页给目标模型勾 `EMBEDDING` → 点「验证」，后端实测写入 `embeddingDimensions` | `POST /llm-configs/models/:id/verify` |
| 2 | 知识库详情页选目标模型 → 「创建目标版本」 | `POST /knowledge-bases/:id/embedding-versions` |
| 3 | 「开始重新向量化」→ 入队 `knowledge-reembed`，页面每 3s 轮询进度 | `POST .../embedding-versions/:vid/re-embed` |
| 4 | 进度 100% 且无失败 → 点「激活」（原子切换，旧版本保留可回滚） | `POST .../embedding-versions/:vid/activate` |

重新向量化**不重新解析原文件**（那是 `POST /documents/:id/reprocess` 干的事），
只复用已有文本块重新生成向量，重跑只捞 `PENDING / FAILED` 的 chunk（已 `DONE` 的不动）。
> ⚠️ job data 里定义了 `retryFailedOnly` 参数，但**当前实现未使用**（`re-embedding.processor.ts` 里
> `pendingChunks(versionId)` 固定取全部 PENDING/FAILED，不分「只重试失败」还是「全量重跑」）——
> 属预留字段，行为上与「失败可重试」一致，但「只重试失败项」这个粒度**还没真正生效**。

> 只有 `status = READY` 的版本能激活，防止跑到一半的版本顶上来造成检索空窗。
> 激活在**一个事务**里做完三件事：旧版本 → `ARCHIVED`、新版本 `isActive = true`、
> 同步 `KnowledgeBase.embeddingModel / embeddingDimension`（所以这俩字段现在是**结果**不是**配置**）。

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

### 5.1.1 ★ 查询向量用哪个 Embedding 模型？（★ 本次改为「按生效版本」）

检索的第一步是把用户的**问题**也变成向量，再拿去和库里的向量比距离。**问题用哪个模型编码，必须和当初写库时一致**，否则等于拿中文词典去查英文句子。

**当前主路径**是 `searchForQuery()`：不再「全局共用一个模型」，
而是**按每个知识库各自的生效版本**分别向量化、分别检索，再合并排序：

```typescript
private async searchForQuery(query, knowledgeBaseIds, explicitModel?, telemetry?, topK = 20) {
  // ① 取这些 KB 的所有「生效版本」
  const versions = await this.prisma.knowledgeBaseEmbeddingVersion.findMany({
    where: { knowledgeBaseId: { in: knowledgeBaseIds }, isActive: true },
    select: { id, knowledgeBaseId, modelId, llmModelId, dimensions, vectorTable },
  });

  // ② 兼容回退：还没建过向量版本 → 沿用旧的 DocumentChunk.embedding + resolveEmbedding()
  if (versions.length === 0) {
    const v = await this.embed(query, explicitModel, knowledgeBaseIds, telemetry);
    return this.vectorStoreService.vectorSearch(knowledgeBaseIds, v, topK, 1.0);
  }

  // ③ 每个版本用自己的模型各向量化一次，各自查自己的物理表
  const buckets = await Promise.all(versions.map(async (v) => {
    const [vector] = await this.embeddingService.embedBatch(
      [query],
      explicitModel ?? v.modelId,
      explicitModel ? null : v.llmModelId,
      telemetry,
    );
    // 维度不符 → 跳过该版本（只 warn，不让整次检索挂掉）
    if (vector?.length !== v.dimensions) return [];
    return this.vectorStoreService.vectorSearchInTable(
      v.vectorTable, [v.knowledgeBaseId], vector, perTable, threshold,
    );
  }));

  return buckets.flat().sort((a, b) => a.distance - b.distance).slice(0, topK);
}
```

**这顺带修掉了旧实现的一个已知限制**：原来 `resolveEmbedding()` 只取 `knowledgeBaseIds[0]` 的模型，
多库混绑不同 Embedding 模型时只有第一个库生效、其余库等于用错模型检索（精度归零）。
现在是**每个库各用自己的模型**，多库混绑也正确。

**旧的 `resolveEmbedding()`**（三档优先级）只在「没有向量版本」的兼容回退分支里生效：

| 档位 | 条件 | 用什么编码问题 |
|------|------|--------------|
| ① | 调用方显式传 `embeddingModel` | 就用它（不带自定义模型） |
| ② | 没选知识库 | 本地 `nomic-embed-text` |
| ③ | 选了知识库 | **第一个库**绑定的模型：`embeddingLlmModelId` 优先 → 否则 `embeddingModel` |

> **⚠️ 别再直接改 `KnowledgeBase.embeddingModel` 来「换模型」**：它已降级为展示元数据
> （由 `activateVersion()` 反向同步）。换模型请走 **§4.10** 的版本流程。

### 5.2 向量检索（`vectorSearch` / ★ `vectorSearchInTable`）

**当前主路径** —— 查版本专属物理表（`vectorSearchInTable`）：

```typescript
const sql = `
  SELECT
    dc."id" AS "chunkId", dc."documentId", d."knowledgeBaseId",
    dc.content, dc.metadata, d."fileName",
    v."embedding" <=> $1::vector AS distance
  FROM "${table}" v                                   -- ★ EmbeddingVector_<versionId>
  JOIN "DocumentChunk" dc ON dc."id" = v."chunkId"
  JOIN "Document" d       ON d."id" = dc."documentId"
  WHERE d."knowledgeBaseId" = ANY($2::text[])
    AND v."embedding" <=> $1::vector <= $3
  ORDER BY v."embedding" <=> $1::vector ASC
  LIMIT $4
`;
return this.prisma.$queryRawUnsafe(sql, vectorString, knowledgeBaseIds, threshold, topK);
```

表名由系统生成（`EmbeddingVector_<uuid>`）**不来自用户输入**，所以拼表名是安全的。

**旧路径（兼容回退）** —— 查 `DocumentChunk.embedding`：

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

**threshold（阈值）怎么理解 —— ⚠️ 这里有两条不同语义，别混：**

| 层 | 变量 | 语义 | 默认 | 方向 |
|----|------|------|------|------|
| **RAG 节点配置**（对外的 `config.threshold`） | `scoreThreshold` | **相似度** | **0.2** | **越大越严格** |
| **SQL 过滤**（`vector-store.service.ts` 内部） | 距离阈值 | **余弦距离** | `1 - scoreThreshold` = **0.8** | 越小越严格 |

`rag.executor.ts:83` 那行 `const scoreThreshold = config.threshold ?? 0.2;` 拿的是**相似度**，
传到 `knowledge-retrieval.service.ts:84` 才换算成距离：`distanceThreshold = 1 - scoreThreshold`。

**所以：**

- 你在 RAG 节点里填 `threshold = 0.2`（默认）→ SQL 实际筛 `距离 ≤ 0.8`
- 0 = 完美匹配，1 以上基本不相关（**这是距离的说法**）
- **想更严格（只留高度相关的）就把 `threshold` 调大**：0.5 → 距离 ≤ 0.5
- **想召回更多就调小**：0.1 → 距离 ≤ 0.9

> ⚠️ 旧文档写「RAG 节点默认 `0.8`」是**上一版距离语义的遗留**，与当前代码不符。
> 顺带一提 hybrid 模式下这个阈值形同虚设 —— `vectorSearch` 被硬编码传 `1.0`（几乎不筛），交给 RRF 融合层筛。

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
  this.vectorStoreService.vectorSearch(ids, queryVector, topK * 4, 1.0), // ★ 实际是 ×4 不是 ×2
  this.vectorStoreService.keywordSearch(ids, query, topK * 4),
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
>
> ⚠️ **旧文档写的是 `topK * 2`，实际代码是 `topK * 4`**（`knowledge-retrieval.service.ts:136-142`）。
> 也就是说 topK=5 时，两路各召回 **20** 条再融合，最后取前 5。
> 召回倍数越大，RRF 越不容易漏掉「只在某一路排第 6~20 名」的相关片段，代价是每次多查一些行。

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
| 1 | 向量维度与**当前生效版本**不符 | 报 `expected N dimensions, not X`（N 不再是固定 768），该 chunk 记 `FAILED` | 建库就选对模型；换模型走 **§4.10** 的版本流程，别手改 `embeddingDimension` |
| 2 | DOCX 解析未实现 | 传 docx → **上传返回 201，但后台任务失败** → 文档 `FAILED` | 用 `mammoth` 补 `DocxParser` |
| ~~3~~ | ~~Chat 页 `knowledgeBaseIds` 被无视~~ **已修** | — | ✅ Chat 页改成 Agent，通过 Knowledge 工具走统一检索；`/ai/chat` 本身仍不带知识库 |
| ~~4~~ | ~~`KnowledgeRetrievalService` 是半成品~~ **已实现** | — | ✅ 现在按 `mode` 路由到 `vector` / `keyword` / `hybrid`（RRF，`rrfK=60`），底层调 `VectorStoreService` + `EmbeddingService`，不再 `throw` |
| 5 | ~~上传是同步的~~ | ✅ **已解决**：现在走 `document-processing` 队列，接口毫秒级返回 | —— |
| 6 | `pageCount`、`tokenCount` 字段声明了但不赋值 | 永远 null | 真用的时候再补逻辑 |
| 7 | 原始 SQL 里表名大小写 | `"DocumentChunk"` 双引号区分大小写 | 写 SQL 时保持一致，别用 `document_chunk` |
| 8 | pgvector 索引是 IVFFlat | 数据量大时检索变慢 | 超过 ~100 万 chunk 再换 HNSW（migration 里有注释好的 SQL） |
| 16 | ★ **`prisma migrate dev` 曾误删 `embedding` 列/索引** | 检索报 `column "embedding" ... does not exist` | **已修**：schema 现在声明 `Unsupported("vector(768)")?`（不再 DROP 列）+ 恢复迁移 `20261010110000_restore_pgvector_embedding`；**注意索引句仍可能出现在生成的迁移里**，跑完 migrate dev 检查 SQL（第 1 篇 §5.2） |
| ~~9~~ | ~~★ **前端 `uploadDocument` 返回类型是错的**~~ **已修** | — | ✅ 新增 `UploadDocumentResult` 接口，`uploadDocument` 返回类型改对；顺带补了 `getDocument(id)` |
| ~~10~~ | ~~★ **`attempts: 3` 重试会插入重复 chunk**~~ **已修** | — | ✅ `process()` 开头加幂等保护：`count` → `$transaction`(`deleteMany` + `decrement chunkCount`) |
| 11 | ★ **切块参数被调到 `100/50`** | 同文档 chunk 数涨约 10 倍，CPU 上向量化极慢 | 本地调试够用；上生产改回 `800/100` |
| 12 | ★ **失败原因不再 HTTP 报错** | 传 docx / 维度错都返回 201，只能靠查列表看 `errorMessage` | 前端轮询时把 `FAILED` + `errorMessage` 弹给用户 |
| 13 | ★ **`document.service.ts` 的 `updateStatus` 成了死代码** | 异步化后 Processor 直接用 `prisma.document.update`，没人调它 | 可以删，或让 Processor 改用它 |
| 14 | ★ **幂等保护只清了 chunk，没清向量** | 删的是 `DocumentChunk` 行（向量跟着行一起没），但如果以后把向量存到外部服务（Qdrant / Milvus）就漏了 | 目前向量在 pgvector 里所以安全；换外部向量库时这里要一起清 |
| 15 | ★ **进度条是假的** | 页面写死 `percentage="60"`；`job.updateProgress(10/30/50/80/100)` 的真值没出口给前端 | 要接 `QueueEvents` + SSE，或让 `getDocument` 返回进度字段 |
| ~~16~~ | ~~★ 自定义 Embedding 模型维度可能不是 768~~ **已解决** | — | ✅ 引入**向量版本化**（§4.10）：一个版本一张 `vector(N)` 物理表，768 不再是硬约束；1024 / 1536 维模型可直接用，走「建版本 → 重向量化 → 激活」 |
| ~~17~~ | ~~★ 多库混用不同 Embedding 模型~~ **已解决** | — | ✅ `searchForQuery()`（§5.1.1）改为**按每个 KB 各自的生效版本**分别向量化再合并，不再只取 `knowledgeBaseIds[0]` 的模型 |
| 18 | ★ **`embeddingLlmModelId` 是软引用（无外键）** | 用户在「模型管理」删掉该模型后，知识库仍指向一个不存在的 id，向量化时 `resolveModelRuntime` 抛错 | 删除模型前校验引用，或运行时做存在性检查 + 优雅回退本地模型 |
| 19 | ★ **未 `READY` 的版本不参与检索** | 正在重新向量化的版本查不到内容，看起来「检索突然变空」 | 这是**刻意设计**（防中间态污染召回）；切换前务必等进度 100% 并点「激活」 |
| 20 | ★ **`knowledge-reembed` 依赖 Redis** | Redis 没起时任务堆积不执行，进度条永远不动，也不报错 | 排查时先确认 Redis；`document-processing` 同理 |
| 21 | ★ **版本物理表不在 Prisma schema 里** | 运行时 `CREATE TABLE`，`prisma migrate dev` 不认识它们 | 不要指望迁移管理这些表；删除版本走 `DELETE .../embedding-versions/:vid`（会 `DROP TABLE`） |

---

## 8. 用 SQL 亲手验证

**查一个知识库有没有向量成功写入：**

**★ 现在的正确姿势：先查知识库有哪些向量版本，再看具体那张表：**

```sql
-- ① 看某知识库的所有向量版本（生效版本 isActive = true）
SELECT id, "modelId", dimensions, "vectorTable", status, "isActive",
       "chunkTotal", "chunkDone", "chunkFailed"
FROM "KnowledgeBaseEmbeddingVersion"
WHERE "knowledgeBaseId" = '你的kbId'
ORDER BY "createdAt";

-- ② 数一下生效版本里实际写了多少条向量（把上面的 vectorTable 填进来）
SELECT count(*) FROM "EmbeddingVector_4d75adfea7f44bdb97295590829ed226";

-- ③ 看有没有失败的块
SELECT status, count(*) FROM "DocumentChunkEmbedding"
WHERE "embeddingVersionId" = '你的versionId' GROUP BY status;
```

**旧版写法（仅在没有向量版本时适用）：**

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
| **写入路（两段）** | 同步段：落盘 → 建记录(`UPLOADED`) → 入队；异步段：解析 → 切块 → **只存文本** → 按生效版本向量化 → 写版本物理表 → `COMPLETED` |
| **检索路** | 问题 → **按各 KB 生效版本**向量化 → 到版本物理表 `<=>` 找最近 → 合并排序 → 拼上下文 → 喂 LLM |
| **★ 队列** | `document-processing`（解析+首次向量化）、**`knowledge-reembed`（★ 换模型后的重新向量化）**；Processor 分别在 `queues/document-processing/` 与 `queues/re-embedding/` |
| **★ 重试** | `attempts: 3` + 指数退避（3s/6s/12s）；失败必须 `throw` 出去 BullMQ 才知道 |
| **★ 幂等保护** | `process()` 开头：`count` 残留 chunk → `$transaction`(`deleteMany` + `decrement chunkCount`)，重投不会重复插入 |
| **状态机（4 态）** | `UPLOADED`（接口写）→ `PROCESSING`（Worker）→ `COMPLETED` / `FAILED` |
| **前端跟进** | `detail.vue` 每 2s 轮询文档列表，有 `UPLOADED`/`PROCESSING` 就刷 |
| **支持格式** | PDF（pdf-parse）、TXT/MD（readFile）；DOCX **未实现** |
| **切块** | ★ chunkSize **100** / overlap **50**（旧版 1000/200，本次调小） |
| **向量化** | `EmbeddingService.embedBatch` 每批 100 条，用**生效向量版本**的模型（`ensureActiveVersion()` 取，不再是 `kb.embeddingModel`） |
| **★ 建库的 Embedding 模型** | `CreateKnowledgeBaseDto.embeddingLlmModelId`（可选）：传了用云端模型，没传回退本地 Ollama；**写入和检索必须用同一个模型** |
| **★ 检索用哪个模型** | ★ 现在按**每个 KB 各自的生效版本**分别向量化（`searchForQuery()`）；旧的 `resolveEmbedding()` 三档只在「无向量版本」回退时用 |
| **★ 维度校验** | 以**生效版本的 `dimensions`** 为准逐条校验（`writeVectors()`），不符的 chunk 记 `FAILED` 不中断整批；`EMBEDDING_DIMENSION = 768` 常量**已删除** |
| **写库** | ★ 写版本物理表 `EmbeddingVector_<versionId>`（upsert）；旧的 `unnest($1,$2)` 批量 UPDATE 仅作兼容回退 |
| **★ 换模型** | 不能改 `embeddingModel` 字段了事 → 走 **§4.10**：建版本 → 重新向量化 → 激活（原子切换、旧版保留可回滚） |
| **向量检索** | `embedding <=> query` 余弦距离，`≤ threshold` 保留，升序取 topK |
| **关键词检索** | PostgreSQL `to_tsvector('simple') @@ plainto_tsquery` + `ts_rank` |
| **混合检索** | 两路并跑 + RRF `Σ 1/(60+rank+1)` 融合取 topK |
| **RAG 节点输出** | `【问题】...【知识库参考】[1]...` 文本，或 `json` 结构 |
| **Count 策略** | 增用 increment，删用重算 |
| **⚠️ 最大坑** | ① 向量列 Prisma 客户端读写不了（`Unsupported` 类型，只能裸 SQL）；② **写入和检索必须用同一个模型**；③ 异步化后失败不再 HTTP 报错；④ 跑 `migrate dev` 看它是否带了 `DROP INDEX dc_embedding_ivf`；⑤ ★ **换模型必须走版本流程，直接改 `embeddingModel`/`embeddingDimension` 是无效的** |

---

上一篇把前端五条链路串到底；下一篇是**全书收尾**：把全部 58 个接口逐字段列出 JSON 示例，前后端字段一一对照，顺便复核前面所有文档的准确性。

→ 打开 [`08-前后端数据对照总表.md`](./08-前后端数据对照总表.md)