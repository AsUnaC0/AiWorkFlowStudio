-- AlterTable: Agent 关联用户自定义模型（为空则回退 Ollama 本地 model）
ALTER TABLE "Agent" ADD COLUMN "llmModelId" TEXT;

-- AlterTable: KnowledgeBase 关联用户自定义 Embedding 模型（为空则回退 Ollama 本地 embeddingModel）
ALTER TABLE "KnowledgeBase" ADD COLUMN "embeddingLlmModelId" TEXT;
