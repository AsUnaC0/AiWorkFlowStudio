-- DropForeignKey
ALTER TABLE "Agent" DROP CONSTRAINT "Agent_createdBy_fkey";

-- DropForeignKey
ALTER TABLE "Agent" DROP CONSTRAINT "Agent_workspaceId_fkey";

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "isSystem" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "workspaceId" DROP NOT NULL,
ALTER COLUMN "createdBy" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "Agent_isSystem_idx" ON "Agent"("isSystem");

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
