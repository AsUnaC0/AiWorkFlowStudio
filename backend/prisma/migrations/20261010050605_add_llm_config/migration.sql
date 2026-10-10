-- DropIndex
-- 注：该索引可能已被更早的 migration（DROP COLUMN embedding）级联删除，
-- 因此用 IF EXISTS 保证在 shadow database 重放时幂等，避免 P3018。
DROP INDEX IF EXISTS "dc_embedding_ivf";

-- CreateTable
CREATE TABLE "LlmProviderConfig" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "baseUrl" TEXT,
    "encryptedApiKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LlmProviderConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlmModel" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "displayName" TEXT,
    "capabilities" TEXT[] DEFAULT ARRAY['CHAT', 'STREAM']::TEXT[],
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LlmModel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LlmProviderConfig_ownerId_idx" ON "LlmProviderConfig"("ownerId");

-- CreateIndex
CREATE INDEX "LlmModel_configId_idx" ON "LlmModel"("configId");

-- CreateIndex
CREATE UNIQUE INDEX "LlmModel_configId_modelId_key" ON "LlmModel"("configId", "modelId");

-- AddForeignKey
ALTER TABLE "LlmProviderConfig" ADD CONSTRAINT "LlmProviderConfig_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LlmModel" ADD CONSTRAINT "LlmModel_configId_fkey" FOREIGN KEY ("configId") REFERENCES "LlmProviderConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;
