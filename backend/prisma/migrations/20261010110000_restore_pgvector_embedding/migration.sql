-- =========================================================================
-- 恢复 pgvector embedding 列
--
-- 上次 auto-generated migration（20261009073241）误 DROP 了 embedding 列。
-- 因为 Prisma schema 里用注释标注 embedding（手写 migration），
-- Prisma 每次 migrate diff 都以为应该删它。
--
-- 此 migration 把 pgvector 扩展 + embedding 列 + 索引全部恢复。
-- =========================================================================

-- 1. 确保 pgvector 扩展开启（全新库可能没开）
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. DocumentChunk 加 embedding 列（如果不存在）
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'DocumentChunk' AND column_name = 'embedding'
    ) THEN
        ALTER TABLE "DocumentChunk" ADD COLUMN "embedding" vector(768);
    END IF;
END $$;

-- 3. 加向量索引（如果不存在）
CREATE INDEX IF NOT EXISTS "dc_embedding_ivf"
  ON "DocumentChunk" USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 100);
