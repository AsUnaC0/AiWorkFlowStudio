> **分册说明**：本文是《AI WorkFlow Studio 项目需求与技术方案 v1.5（MCP / Skill 更新版）》的拆分分册之一，覆盖原文档**第 11 章**（知识库 / 文档 / 解析 / 切块 / 向量 / 检索 / RAG 全链路）。内容与原文一致，仅按模块拆开便于单独阅读。
> **分册索引**：[README](./README.md) ｜ 上一册：[05-执行引擎-异步-流式.md](./05-执行引擎-异步-流式.md) ｜ 下一册：[07-Agent与结构化输出.md](./07-Agent与结构化输出.md)

---

# 11. 知识库

知识库是 RAG（Retrieval-Augmented Generation）能力的基础设施。
**第 5.2 节「共享底层：KnowledgeRetrievalService」** 已描述了上层调用接口，
本章描述底层存储、处理管线与检索策略。

## 11.1 Knowledge Base

知识库是文档集合的容器，属于 Workspace 级别资源。
一个 Workspace 可拥有多个知识库，Agent、Workflow 可分别关联不同的知识库。

```text
KnowledgeBase
├── id
├── workspaceId
├── name
├── description
├── embeddingModel        ← 该库使用的 Embedding 模型（所有文档统一）
├── documentCount         ← 冗余字段，便于列表展示
├── chunkCount
├── createdAt
└── updatedAt
```

## 11.2 Document

Document 是知识库中的文件实体，承载原始文件元信息与处理状态。
详见 **第 17 章数据库核心模型 → documents**。

状态机：

```text
UPLOADED → PROCESSING → COMPLETED
                    ↘ FAILED（errorMessage 记录原因）
```

## 11.3 File Storage

文件原始二进制不直接存数据库，落盘到磁盘或对象存储：

- **本地开发**：`/uploads/<knowledgeBaseId>/<documentId>.<ext>`
- **生产环境**：S3 / MinIO / OSS，`storagePath` 存 URL

数据库 `documents.storagePath` 只记录位置，`documents.fileSize` / `mimeType` / `pageCount` 冗余加速列表展示。

## 11.4 Document Parser

不同文件格式对应不同 Parser，统一实现 `DocumentParser` 接口：

```typescript
interface DocumentParser {
  readonly supportedExtensions: string[];
  parse(filePath: string): Promise<ParseResult>;
}

interface ParseResult {
  content: string;
  pageCount?: number;
  metadata?: Record<string, unknown>;
}
```

| 格式       | 实现               | 依赖库                        |
| -------- | ---------------- | -------------------------- |
| PDF      | `PdfParser`      | `pdf-parse` / `pdfjs-dist` |
| DOCX     | `DocxParser`     | `mammoth`                  |
| TXT      | `TxtParser`      | `node:fs` 直接读取             |
| Markdown | `MarkdownParser` | `node:fs` 直接读取             |

`DocumentParserService` 作为 Parser 路由器，根据文件扩展名自动选择实现。

## 11.5 Text Cleaning

解析后的原始文本通常包含噪声，进入切块前需经过清洗：

- 合并多余空白字符（连续空格 / 空行 → 单空格 / 单空行）
- 去除页眉页脚（重复模式识别）
- 去除目录、页码
- 统一换行符（`\r\n` → `\n`）
- 可选：保留文档层级结构（标题 → 段落），后续写入 `metadata.section`

## 11.6 Chunking

清洗后的长文本切分为 Chunk（文档块），每个 Chunk 独立 Embedding 和存储。

### Chunk Size

默认 **500 Token / Chunk**（约 300\~400 中文字），可按知识库配置调整。
过大影响检索精度，过小丢失上下文。

### Overlap

相邻 Chunk 之间 **重叠 10%\~15%**（默认 80 Token），防止关键信息恰好落在切割边界。

### Metadata

每个 Chunk 保留结构化元数据，支撑 RAG 引用：

```json
{
  "page": 3,
  "section": "考勤制度",
  "heading": "工作时间",
  "chunkIndex": 2
}
```

> 作用：检索命中后可告诉用户「根据《员工手册》第 3 页 §考勤制度」，
> 而不是只能说「来源：员工手册.pdf」。

## 11.7 Embedding

### Embedding Provider

建议接入 Ollama（本地）或 OpenAI Embedding API，由 `EmbeddingService` 统一封装。

### Embedding Model

| 模型                                | 维度   | 备注        |
| --------------------------------- | ---- | --------- |
| `nomic-embed-text` (Ollama)       | 768  | 中文友好，本地可跑 |
| `text-embedding-3-small` (OpenAI) | 1536 | 通用，成本低    |

每个 `KnowledgeBase` 在创建时指定 `embeddingModel`，该库所有 Chunk 使用同一模型，保证向量空间一致。

### Dimension

`document_chunks.embedding` 的向量维度必须与模型输出一致，
由 `EmbeddingService` 在写入时校验，避免混用模型。

## 11.8 Vector Storage

向量存储方案：**PostgreSQL + pgvector**。

选择 pgvector 而非独立向量库（Chroma / Qdrant）的理由：

- 项目已依赖 PostgreSQL，零额外运维成本
- 关系型数据（documents / chunks）与向量同库，事务一致性好
- pgvector 0.7+ 支持 HNSW 索引，百万级向量延迟可接受

```sql
-- 启用扩展
CREATE EXTENSION IF NOT EXISTS vector;

-- Chunk 表示例
CREATE TABLE document_chunks (
  id          text PRIMARY KEY,
  document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  content     text NOT NULL,
  chunk_index integer NOT NULL,
  token_count integer,
  embedding   vector(768),           -- 维度由 EmbeddingModel 决定
  metadata    jsonb,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- HNSW 索引（向量检索加速）
CREATE INDEX idx_document_chunks_embedding
  ON document_chunks
  USING hnsw (embedding vector_cosine_ops);
```

## 11.9 Document Processing

文件从上传到入库是异步管线，由 **BullMQ + Redis** 驱动。

### 管线阶段

```text
[1] UPLOADED      用户上传文件
     ↓
[2] PROCESSING    BullMQ Worker 拉取任务
     ├── DocumentParserService.parse()   → 原始文本
     ├── Text Cleaning                   → 清洗文本
     ├── ChunkService.chunk()            → Chunk[]
     ├── EmbeddingService.embedBatch()   → 向量[]
     └── VectorStoreService.upsert()     → pgvector
     ↓
[3] COMPLETED     处理完成，chunkCount 更新
     或
[3] FAILED        失败，errorMessage 记录原因（Parser 不支持 / Embedding 超时 / ...）
```

### Processing Status

`documents.status` 与 `documents.errorMessage` 实时反映管线状态，
前端知识库列表页据此显示进度和失败提示。

## 11.10 Knowledge Retrieval

所有上层检索请求统一走 **`KnowledgeRetrievalService`**（详见 5.2 节），
内部支持三种策略：

### Vector Search

用户 Query → Embedding → pgvector `ORDER BY embedding <=> query_vector LIMIT K`。
适用于语义相近但措辞不同的场景。

### Keyword Search

PostgreSQL `tsvector` / `tsquery` 全文检索，或 Elasticsearch BM25。
适用于精确关键词匹配（专有名词、编号）。

### Hybrid Search

**Vector + Keyword 并发执行 → Reciprocal Rank Fusion (RRF) 融合**。

```
score(d) = Σ 1 / (k + rank_i(d))
```

默认 `k = 60`，两路各取 topK×4，融合后取 topK 返回。
兼顾语义和关键词，是推荐默认模式。

## 11.11 RAG

RAG 是知识库能力的最终消费形态，执行链路：

```text
用户 Query
  ↓
KnowledgeRetrievalService.search({ query, mode: 'hybrid', topK: 5 })
  ↓
SearchResult[]  (chunk.content + chunk.metadata + chunk.fileName)
  ↓
拼接 Context Prompt
  ┌────────────────────────────────────┐
  │ 根据以下知识库内容回答问题：           │
  │                                    │
  │ [来源：员工手册.pdf §考勤制度 p.3]    │
  │ 员工工作时间为 9:00 - 18:00。        │
  │                                    │
  │ [来源：员工手册.pdf §请假流程 p.7]    │
  │ 事假需提前 1 天申请...               │
  │                                    │
  │ 用户问题：{query}                    │
  └────────────────────────────────────┘
  ↓
LLM 生成回答（可附带引用来源）
  ↓
答案 + 引用（chunkId / fileName / metadata）
```

> RAG 节点（Workflow 中）、LLM 节点内置 RAG、Agent Knowledge Tool
> 三条链路都复用 `KnowledgeRetrievalService`，
> 避免各自实现检索逻辑导致行为不一致。

***
