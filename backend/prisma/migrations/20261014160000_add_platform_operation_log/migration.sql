-- 平台助理操作审计表
-- 配套 20261014160000_add_platform_operation_log
--
-- 平台助理通过内置平台工具创建 / 修改 / 执行资源时，每次工具调用落一条记录。
-- 纯新增表，不影响既有数据；与 ChatMessage.trail 解耦（trail 进上下文，本表只做审计）。

CREATE TABLE "PlatformOperationLog" (
    "id"           TEXT NOT NULL,
    "userId"       TEXT NOT NULL,
    "workspaceId"  TEXT,
    "sessionId"    TEXT,
    "agentId"      TEXT,
    "tool"         TEXT NOT NULL,
    "action"       TEXT NOT NULL DEFAULT 'QUERY',
    "riskLevel"    TEXT NOT NULL DEFAULT 'LOW',
    "targetType"   TEXT,
    "targetId"     TEXT,
    "targetName"   TEXT,
    "status"       TEXT NOT NULL DEFAULT 'SUCCESS',
    "summary"      TEXT,
    "link"         TEXT,
    "params"       JSONB,
    "errorMessage" TEXT,
    "durationMs"   INTEGER,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformOperationLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlatformOperationLog_userId_createdAt_idx"
    ON "PlatformOperationLog"("userId", "createdAt");

CREATE INDEX "PlatformOperationLog_sessionId_idx"
    ON "PlatformOperationLog"("sessionId");

CREATE INDEX "PlatformOperationLog_tool_idx"
    ON "PlatformOperationLog"("tool");

CREATE INDEX "PlatformOperationLog_targetType_targetId_idx"
    ON "PlatformOperationLog"("targetType", "targetId");

CREATE INDEX "PlatformOperationLog_status_idx"
    ON "PlatformOperationLog"("status");
