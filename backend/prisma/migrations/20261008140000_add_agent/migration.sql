-- Agent 模型：可配置的 AI Agent（绑定 Workflow / Knowledge / LLM Prompt）

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "model" TEXT NOT NULL DEFAULT 'qwen2.5:7b',
    "systemPrompt" TEXT,
    "workflowIds" TEXT[],
    "knowledgeBaseIds" TEXT[],
    "maxToolIterations" INTEGER NOT NULL DEFAULT 10,
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Agent_workspaceId_idx" ON "Agent"("workspaceId");

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
