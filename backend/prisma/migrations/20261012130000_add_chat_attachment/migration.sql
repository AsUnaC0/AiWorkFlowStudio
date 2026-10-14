-- CreateTable: ChatAttachment —— 聊天输入附件（用户上传给 AI 的文件）
-- 与 GeneratedFile（AI 产出文件）解耦：独立生命周期、独立处理状态、不参与知识库向量化

CREATE TABLE "ChatAttachment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT,
    "messageId" TEXT,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "size" INTEGER NOT NULL DEFAULT 0,
    "storageKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'TEXT',
    "status" TEXT NOT NULL DEFAULT 'UPLOADED',
    "extractedText" TEXT,
    "charCount" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT,
    "parseError" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatAttachment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChatAttachment_storageKey_key" ON "ChatAttachment"("storageKey");
CREATE INDEX "ChatAttachment_userId_createdAt_idx" ON "ChatAttachment"("userId", "createdAt");
CREATE INDEX "ChatAttachment_sessionId_createdAt_idx" ON "ChatAttachment"("sessionId", "createdAt");
CREATE INDEX "ChatAttachment_messageId_idx" ON "ChatAttachment"("messageId");
CREATE INDEX "ChatAttachment_status_idx" ON "ChatAttachment"("status");

-- AddForeignKey: 会话 / 消息删除后附件记录保留（仅置空关联）
ALTER TABLE "ChatAttachment" ADD CONSTRAINT "ChatAttachment_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ChatAttachment" ADD CONSTRAINT "ChatAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
