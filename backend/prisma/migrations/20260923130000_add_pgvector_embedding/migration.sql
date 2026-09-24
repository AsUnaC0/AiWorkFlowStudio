-- =========================================================================
-- 1. 开启 pgvector 扩展（PostgreSQL 必须先安装 pgvector 包）
-- =========================================================================
CREATE EXTENSION IF NOT EXISTS vector;

-- =========================================================================
-- 2. DocumentChunk 加 embedding 列（768 维，匹配 nomic-embed-text）
--    Prisma schema 里这列用注释占位，靠这条手写 SQL 添加
-- =========================================================================
ALTER TABLE "DocumentChunk"
  ADD COLUMN IF NOT EXISTS "embedding" vector(768);

-- =========================================================================
-- 3. 向量索引（IVFFlat，100 个聚类，适合中小规模数据）
--    数据量大（>100 万 chunk）可换成 HNSW：
--      CREATE INDEX dc_embedding_hnsw ON "DocumentChunk" USING hnsw ("embedding" vector_cosine_ops);
-- =========================================================================
CREATE INDEX IF NOT EXISTS "dc_embedding_ivf"
  ON "DocumentChunk"
  USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 100);
