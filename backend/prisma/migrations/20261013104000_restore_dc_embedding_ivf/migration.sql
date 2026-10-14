-- =========================================================================
-- 重建 DocumentChunk.embedding 的 IVFFlat 向量索引
--
-- 背景：该索引在真实库中缺失（migrate dev 报 drift:
--   [*] Changed the `DocumentChunk` table / [-] Removed index on columns (embedding)）。
--   因为 schema.prisma 里 embedding 相关索引是手写 SQL 维护的，
--   一旦执行过 `prisma db push`，Prisma 会把它当作「schema 中不存在的对象」而删除，
--   但 migration 历史里仍然保留着创建语句，于是历史与库产生漂移。
--
-- 这条迁移把索引补回来，使历史与库重新一致（不需要 reset 数据库）。
-- 注意：IVFFlat 索引在空表/小表上无实际加速效果，主要保证与迁移历史一致；
-- 数据量增长后可改为 HNSW：
--   CREATE INDEX dc_embedding_hnsw ON "DocumentChunk" USING hnsw ("embedding" vector_cosine_ops);
-- =========================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- 若列不存在则先补列（防御：某些环境被 db push 删过）
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'DocumentChunk' AND column_name = 'embedding'
    ) THEN
        ALTER TABLE "DocumentChunk" ADD COLUMN "embedding" vector(768);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "dc_embedding_ivf"
  ON "DocumentChunk" USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 100);
