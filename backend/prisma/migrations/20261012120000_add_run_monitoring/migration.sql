-- 工作流运行监控增强：错误码 / 触发方式 / 耗时 + 模型调用日志
-- 配套 20261012120000_add_run_monitoring

-- 1. WorkflowRun 增加 errorCode / triggerType / durationMs
ALTER TABLE "WorkflowRun" ADD COLUMN "errorCode" TEXT;
ALTER TABLE "WorkflowRun" ADD COLUMN "triggerType" TEXT NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "WorkflowRun" ADD COLUMN "durationMs" INTEGER;
CREATE INDEX IF NOT EXISTS "WorkflowRun_createdAt_idx" ON "WorkflowRun" ("createdAt");

-- 2. WorkflowNodeRun 增加 errorCode / attemptsMade
ALTER TABLE "WorkflowNodeRun" ADD COLUMN "errorCode" TEXT;
ALTER TABLE "WorkflowNodeRun" ADD COLUMN "attemptsMade" INTEGER NOT NULL DEFAULT 0;

-- 3. ModelCallLog 新建
CREATE TABLE "ModelCallLog" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "workflowId" TEXT,
  "runId" TEXT,
  "nodeRunId" TEXT,
  "agentId" TEXT,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "callType" TEXT NOT NULL DEFAULT 'CHAT',
  "promptTokens" INTEGER NOT NULL DEFAULT 0,
  "completionTokens" INTEGER NOT NULL DEFAULT 0,
  "totalTokens" INTEGER NOT NULL DEFAULT 0,
  "latencyMs" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'SUCCESS',
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "estimatedCost" DOUBLE PRECISION,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ModelCallLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ModelCallLog_workspaceId_idx" ON "ModelCallLog" ("workspaceId");
CREATE INDEX IF NOT EXISTS "ModelCallLog_runId_idx" ON "ModelCallLog" ("runId");
CREATE INDEX IF NOT EXISTS "ModelCallLog_nodeRunId_idx" ON "ModelCallLog" ("nodeRunId");
CREATE INDEX IF NOT EXISTS "ModelCallLog_model_idx" ON "ModelCallLog" ("model");
CREATE INDEX IF NOT EXISTS "ModelCallLog_status_idx" ON "ModelCallLog" ("status");
CREATE INDEX IF NOT EXISTS "ModelCallLog_createdAt_idx" ON "ModelCallLog" ("createdAt");
