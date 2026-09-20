/*
  Warnings:

  - You are about to drop the column `workspaceId` on the `KnowledgeBase` table. All the data in the column will be lost.
  - Added the required column `ownerId` to the `KnowledgeBase` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "KnowledgeBase" DROP CONSTRAINT "KnowledgeBase_workspaceId_fkey";

-- DropIndex
DROP INDEX "KnowledgeBase_workspaceId_idx";

-- AlterTable
ALTER TABLE "KnowledgeBase" DROP COLUMN "workspaceId",
ADD COLUMN     "ownerId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "WorkspaceKnowledgeBase" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "knowledgeBaseId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceKnowledgeBase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkspaceKnowledgeBase_knowledgeBaseId_idx" ON "WorkspaceKnowledgeBase"("knowledgeBaseId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceKnowledgeBase_workspaceId_knowledgeBaseId_key" ON "WorkspaceKnowledgeBase"("workspaceId", "knowledgeBaseId");

-- CreateIndex
CREATE INDEX "KnowledgeBase_ownerId_idx" ON "KnowledgeBase"("ownerId");

-- AddForeignKey
ALTER TABLE "KnowledgeBase" ADD CONSTRAINT "KnowledgeBase_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceKnowledgeBase" ADD CONSTRAINT "WorkspaceKnowledgeBase_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceKnowledgeBase" ADD CONSTRAINT "WorkspaceKnowledgeBase_knowledgeBaseId_fkey" FOREIGN KEY ("knowledgeBaseId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
