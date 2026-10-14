-- =========================================================================
-- ⚠️ 目录名叫 "init"，但它**不是**初始化迁移 —— 目录名是 `prisma migrate dev`
--    自动生成时取的，内容是后来手写的，改名会影响已应用记录，因此保持原样。
--
-- 本迁移真实做两件事：
--   1. 补 ModelCallLog 的两个外键（runId / nodeRunId）
--   2. 确保 pgvector 的 IVFFlat 索引 dc_embedding_ivf 存在
--
-- 项目的迁移规矩：一律手写 SQL（migrate dev 会误删向量索引，见文件末尾说明）。
-- =========================================================================
-- AddForeignKey（幂等写法：约束可能已经存在，避免重复执行报错 42710）
-- =========================================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ModelCallLog_runId_fkey'
    ) THEN
        ALTER TABLE "ModelCallLog" ADD CONSTRAINT "ModelCallLog_runId_fkey"
          FOREIGN KEY ("runId") REFERENCES "WorkflowRun"("id")
          ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ModelCallLog_nodeRunId_fkey'
    ) THEN
        ALTER TABLE "ModelCallLog" ADD CONSTRAINT "ModelCallLog_nodeRunId_fkey"
          FOREIGN KEY ("nodeRunId") REFERENCES "WorkflowNodeRun"("id")
          ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- =========================================================================
-- 保护 pgvector 向量索引 dc_embedding_ivf
--
-- Prisma 自动生成本迁移时会在开头插入：
--     DROP INDEX "dc_embedding_ivf";
-- 必须手动删掉。原因：dc_embedding_ivf 是 pgvector 的 IVFFlat 索引，
-- 由手写 SQL 迁移维护；schema.prisma 无法声明它（Prisma 7 不支持向量索引，
-- 官方 pgvector 扩展要等 Prisma 8），所以 Prisma 每次 diff 都把它当成
-- 「schema 里没有的多余对象」并生成 DROP。
-- 以后每次 migrate dev 生成新迁移后，都要检查并移除这类 DROP 语句，
-- 否则向量检索索引会丢失；这里再补一次创建，确保索引一定存在。
-- =========================================================================
CREATE INDEX IF NOT EXISTS "dc_embedding_ivf"
  ON "DocumentChunk" USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 100);
