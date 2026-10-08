-- CreateTable
CREATE TABLE "WorkflowNodeRun" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "nodeType" TEXT NOT NULL,
    "label" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "input" JSONB,
    "output" JSONB,
    "branch" TEXT,
    "metadata" JSONB,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowNodeRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkflowNodeRun_runId_idx" ON "WorkflowNodeRun"("runId");

-- CreateIndex
CREATE INDEX "WorkflowNodeRun_runId_nodeId_idx" ON "WorkflowNodeRun"("runId", "nodeId");

-- AddForeignKey
ALTER TABLE "WorkflowNodeRun" ADD CONSTRAINT "WorkflowNodeRun_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
