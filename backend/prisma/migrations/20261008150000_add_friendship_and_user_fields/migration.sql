-- =========================================================================
-- Friendship 模块 + User.avatar / User.status
-- 干净环境运行 `prisma migrate deploy` 可直接建表
-- =========================================================================

-- 1. User 表新增字段（IF NOT EXISTS 保护幂等）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'User' AND column_name = 'avatar'
  ) THEN
    ALTER TABLE "User" ADD COLUMN "avatar" TEXT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'User' AND column_name = 'status'
  ) THEN
    ALTER TABLE "User" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'OFFLINE';
  END IF;
END $$;

-- 2. Friendship 表
CREATE TABLE IF NOT EXISTS "Friendship" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "friendId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Friendship_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Friendship_userId_friendId_key" ON "Friendship"("userId", "friendId");
CREATE INDEX IF NOT EXISTS "Friendship_friendId_idx" ON "Friendship"("friendId");
CREATE INDEX IF NOT EXISTS "Friendship_status_idx" ON "Friendship"("status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'Friendship_userId_fkey'
  ) THEN
    ALTER TABLE "Friendship"
      ADD CONSTRAINT "Friendship_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'Friendship_friendId_fkey'
  ) THEN
    ALTER TABLE "Friendship"
      ADD CONSTRAINT "Friendship_friendId_fkey"
      FOREIGN KEY ("friendId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- 3. 恢复 DocumentChunk.embedding（db push 曾把它删了，干净环境也需要）
CREATE EXTENSION IF NOT EXISTS vector;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'DocumentChunk' AND column_name = 'embedding'
  ) THEN
    ALTER TABLE "DocumentChunk" ADD COLUMN "embedding" vector(768);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "dc_embedding_ivf"
  ON "DocumentChunk" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);
