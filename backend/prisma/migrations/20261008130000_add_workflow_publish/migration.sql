-- Workflow 发布功能：增加 publishedVersionId 字段（指向已发布版本）
-- 区分 currentVersionId（草稿最新版本）和 publishedVersionId（Agent 调用的稳定版本）

-- AddColumn: publishedVersionId
ALTER TABLE "Workflow" ADD COLUMN "publishedVersionId" TEXT;

-- CreateIndex（unique）：一个 Workflow 只能有一个已发布版本
CREATE UNIQUE INDEX "Workflow_publishedVersionId_key" ON "Workflow"("publishedVersionId");

-- AddForeignKey：publishedVersionId → WorkflowVersion.id（删除版本时设为 NULL）
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_publishedVersionId_fkey"
  FOREIGN KEY ("publishedVersionId") REFERENCES "WorkflowVersion"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
