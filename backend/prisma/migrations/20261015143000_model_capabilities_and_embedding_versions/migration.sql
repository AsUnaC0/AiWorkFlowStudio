-- 模型能力体系扩展 + 知识库向量版本化
--
-- 说明：本迁移由 `prisma migrate diff --from-config-datasource --to-schema` 生成后手工整理。
--   * 已移除 diff 自动产生的 `DROP INDEX "dc_embedding_ivf";`（Prisma 无法识别手写索引，
--     该索引由早期迁移维护，不能让 Prisma 静默删掉）。
--   * 追加了「为已有知识库建立 v1 向量版本 + 迁移已有向量」的数据迁移。
--
-- ⚠️ 迁移只负责表结构与数据搬运，不负责重新计算向量（Schema Migration ≠ Embedding Migration）。

-- AlterTable
ALTER TABLE "LlmModel" ADD COLUMN     "embeddingDimensions" INTEGER,
ADD COLUMN     "inputModalities" TEXT[] DEFAULT ARRAY['text']::TEXT[],
ADD COLUMN     "isVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "maxInputTokens" INTEGER,
ADD COLUMN     "outputModalities" TEXT[] DEFAULT ARRAY['text']::TEXT[],
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DocumentChunkEmbedding" (
    "id" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "embeddingVersionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentChunkEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeBaseEmbeddingVersion" (
    "id" TEXT NOT NULL,
    "knowledgeBaseId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "llmModelId" TEXT,
    "dimensions" INTEGER NOT NULL,
    "vectorTable" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "chunkTotal" INTEGER NOT NULL DEFAULT 0,
    "chunkDone" INTEGER NOT NULL DEFAULT 0,
    "chunkFailed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "activatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeBaseEmbeddingVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentChunkEmbedding_embeddingVersionId_idx" ON "DocumentChunkEmbedding"("embeddingVersionId");

-- CreateIndex
CREATE INDEX "DocumentChunkEmbedding_embeddingVersionId_status_idx" ON "DocumentChunkEmbedding"("embeddingVersionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentChunkEmbedding_chunkId_embeddingVersionId_key" ON "DocumentChunkEmbedding"("chunkId", "embeddingVersionId");

-- CreateIndex
CREATE INDEX "KnowledgeBaseEmbeddingVersion_knowledgeBaseId_idx" ON "KnowledgeBaseEmbeddingVersion"("knowledgeBaseId");

-- CreateIndex
CREATE INDEX "KnowledgeBaseEmbeddingVersion_knowledgeBaseId_isActive_idx" ON "KnowledgeBaseEmbeddingVersion"("knowledgeBaseId", "isActive");

-- AddForeignKey
ALTER TABLE "DocumentChunkEmbedding" ADD CONSTRAINT "DocumentChunkEmbedding_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "DocumentChunk"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentChunkEmbedding" ADD CONSTRAINT "DocumentChunkEmbedding_embeddingVersionId_fkey" FOREIGN KEY ("embeddingVersionId") REFERENCES "KnowledgeBaseEmbeddingVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeBaseEmbeddingVersion" ADD CONSTRAINT "KnowledgeBaseEmbeddingVersion_knowledgeBaseId_fkey" FOREIGN KEY ("knowledgeBaseId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- 数据迁移：为已有知识库建立 v1 向量版本，并把已有向量搬过去
-- ===========================================================================

-- 1) 每个知识库建立 v1（沿用其当前 embedding 配置），并直接设为激活
--    vectorTable 由版本 id 派生：EmbeddingVector_<id 去掉横线>
INSERT INTO "KnowledgeBaseEmbeddingVersion"
  ("id", "knowledgeBaseId", "modelId", "llmModelId", dimensions, "vectorTable", status,
   "isActive", "activatedAt", "createdAt", "updatedAt")
SELECT
  v.uid,
  kb."id",
  kb."embeddingModel",
  kb."embeddingLlmModelId",
  COALESCE(NULLIF(kb."embeddingDimension", 0), 768),
  'EmbeddingVector_' || replace(v.uid::text, '-', ''),
  'READY',
  true,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "KnowledgeBase" kb
CROSS JOIN LATERAL (SELECT gen_random_uuid() AS uid) v
WHERE NOT EXISTS (
  SELECT 1 FROM "KnowledgeBaseEmbeddingVersion" ev WHERE ev."knowledgeBaseId" = kb."id"
);

-- 2) 为每个版本创建专属物理向量表（列固定 vector(dimensions)，建 HNSW 索引）
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT ev."id", ev."vectorTable", ev.dimensions FROM "KnowledgeBaseEmbeddingVersion" ev LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I (
         "chunkId" TEXT NOT NULL PRIMARY KEY REFERENCES "DocumentChunk"("id") ON DELETE CASCADE,
         "embedding" vector(%s) NOT NULL
       )',
      r."vectorTable", r.dimensions
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I USING hnsw (embedding vector_cosine_ops)',
      'hnsw_' || r."vectorTable", r."vectorTable"
    );
  END LOOP;
END $$;

-- 3) 把已有向量搬进 v1 的物理表，并登记状态（旧列 DocumentChunk.embedding 原样保留，便于回滚）
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT ev."id" AS vid, ev."vectorTable" AS vt, ev."knowledgeBaseId" AS kbid
           FROM "KnowledgeBaseEmbeddingVersion" ev LOOP
    EXECUTE format(
      'INSERT INTO %I ("chunkId", "embedding")
       SELECT dc."id", dc."embedding"
       FROM "DocumentChunk" dc
       JOIN "Document" d ON d."id" = dc."documentId"
       WHERE d."knowledgeBaseId" = %L AND dc."embedding" IS NOT NULL AND vector_dims(dc."embedding") = %s
       ON CONFLICT ("chunkId") DO NOTHING',
      r.vt, r.kbid, (SELECT ev.dimensions FROM "KnowledgeBaseEmbeddingVersion" ev WHERE ev."id" = r.vid)
    );

    EXECUTE format(
      'INSERT INTO "DocumentChunkEmbedding" ("id", "chunkId", "embeddingVersionId", status, "createdAt", "updatedAt")
       SELECT gen_random_uuid(), t."chunkId", %L, ''DONE'', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
       FROM %I t
       ON CONFLICT ("chunkId", "embeddingVersionId") DO NOTHING',
      r.vid, r.vt
    );
  END LOOP;
END $$;

-- 4) 回写版本统计
UPDATE "KnowledgeBaseEmbeddingVersion" v
SET "chunkTotal" = src.total,
    "chunkDone"   = src.done,
    "chunkFailed" = src.failed
FROM (
  SELECT
    dce."embeddingVersionId" AS vid,
    COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE dce.status = 'DONE')::int AS done,
    COUNT(*) FILTER (WHERE dce.status = 'FAILED')::int AS failed
  FROM "DocumentChunkEmbedding" dce
  GROUP BY dce."embeddingVersionId"
) src
WHERE v."id" = src.vid;
