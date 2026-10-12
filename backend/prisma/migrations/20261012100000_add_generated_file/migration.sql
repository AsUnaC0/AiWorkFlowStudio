-- CreateTable: GeneratedFile —— Agent / Chat / Workflow 生成的文件元数据（docx / xlsx / pdf / md / csv）
-- 二进制不入库：统一落到 StorageService（本地磁盘 / 七牛云），库内只保存 storageKey

CREATE TABLE "GeneratedFile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "sessionId" TEXT,
    "messageId" TEXT,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "size" INTEGER NOT NULL DEFAULT 0,
    "storageKey" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'chat',
    "status" TEXT NOT NULL DEFAULT 'READY',
    "previewType" TEXT,
    "errorMessage" TEXT,
    "title" TEXT,
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GeneratedFile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GeneratedFile_storageKey_key" ON "GeneratedFile"("storageKey");
CREATE INDEX "GeneratedFile_userId_createdAt_idx" ON "GeneratedFile"("userId", "createdAt");
CREATE INDEX "GeneratedFile_sessionId_createdAt_idx" ON "GeneratedFile"("sessionId", "createdAt");
CREATE INDEX "GeneratedFile_messageId_idx" ON "GeneratedFile"("messageId");
CREATE INDEX "GeneratedFile_status_idx" ON "GeneratedFile"("status");

-- AddForeignKey: 关联会话 / 消息（删除会话时文件记录保留，仅置空）
ALTER TABLE "GeneratedFile" ADD CONSTRAINT "GeneratedFile_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GeneratedFile" ADD CONSTRAINT "GeneratedFile_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
