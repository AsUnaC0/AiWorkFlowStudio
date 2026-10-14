-- DropIndex
-- 注意：必须加 IF EXISTS。该索引可能已被更早的迁移级联删除——
-- 20261009073241 执行了 `ALTER TABLE "DocumentChunk" DROP COLUMN "embedding"`，
-- 删除列会连带删除建立在该列上的 dc_embedding_ivf 索引。
-- 因此在新库/shadow database 上完整重放迁移链时，此处索引可能并不存在，
-- 不带 IF EXISTS 会报 42704 "index does not exist" 导致 P3006/P3018。
DROP INDEX IF EXISTS "dc_embedding_ivf";
