-- 平台助理人格化 + 桌宠偏好 + 记忆模块 + 短时效凭证
-- 配套 20261028120000_add_persona_pet_memory
--
-- 全部为新增表 / 新增可空关系，不改动既有列，不影响既有数据。
-- 注意：本迁移刻意不涉及 pgvector。Memory.embedding 用 DOUBLE PRECISION[]
-- （见 schema.prisma 中 Memory 的注释），避免重蹈「每版本一张物理向量表」的维护成本。

-- ---------------------------------------------------------------------------
-- AgentPersona（人格配置，1:1 Agent）
-- ---------------------------------------------------------------------------

CREATE TABLE "AgentPersona" (
    "id"                       TEXT NOT NULL,
    "agentId"                  TEXT NOT NULL,
    "name"                     TEXT NOT NULL DEFAULT '小蝶',
    "tags"                     TEXT[] NOT NULL DEFAULT ARRAY['仿真','真人感','甜美','粘人']::TEXT[],
    "systemPrompt"             TEXT NOT NULL,
    "avatar"                   TEXT,
    "voiceEnabled"             BOOLEAN NOT NULL DEFAULT true,
    "voiceId"                  TEXT NOT NULL DEFAULT 'zh-CN-XiaoyiNeural',
    "speechRate"               DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "pitch"                    DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "desktopPetEnabled"        BOOLEAN NOT NULL DEFAULT false,
    "proactiveChatEnabled"     BOOLEAN NOT NULL DEFAULT false,
    "proactiveChatFrequency"   TEXT NOT NULL DEFAULT 'low',
    "screenPerceptionEnabled"  BOOLEAN NOT NULL DEFAULT false,
    "screenPerceptionInterval" INTEGER NOT NULL DEFAULT 60,
    "personaVersion"           INTEGER NOT NULL DEFAULT 1,
    "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentPersona_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentPersona_agentId_key" ON "AgentPersona"("agentId");

ALTER TABLE "AgentPersona"
    ADD CONSTRAINT "AgentPersona_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "Agent"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- DesktopPetSettings（桌宠客户端偏好，按用户）
-- ---------------------------------------------------------------------------

CREATE TABLE "DesktopPetSettings" (
    "id"                      TEXT NOT NULL,
    "userId"                  TEXT NOT NULL,
    "enabled"                 BOOLEAN NOT NULL DEFAULT false,
    "voiceEnabled"            BOOLEAN NOT NULL DEFAULT true,
    "proactiveChatEnabled"    BOOLEAN NOT NULL DEFAULT false,
    "screenPerceptionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "perceptionInterval"      INTEGER NOT NULL DEFAULT 60,
    "autoLaunch"              BOOLEAN NOT NULL DEFAULT false,
    "positionX"               INTEGER,
    "positionY"               INTEGER,
    "scale"                   DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "updatedAt"               TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DesktopPetSettings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DesktopPetSettings_userId_key" ON "DesktopPetSettings"("userId");

-- ---------------------------------------------------------------------------
-- Memory（对话记忆）
-- ---------------------------------------------------------------------------

CREATE TABLE "Memory" (
    "id"                   TEXT NOT NULL,
    "userId"               TEXT NOT NULL,
    "agentId"              TEXT NOT NULL,
    "category"             TEXT NOT NULL DEFAULT 'FACT',
    "summary"              TEXT NOT NULL,
    "content"              TEXT NOT NULL,
    "importance"           DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "embedding"            DOUBLE PRECISION[] NOT NULL DEFAULT ARRAY[]::DOUBLE PRECISION[],
    "embeddingModel"       TEXT,
    "sourceConversationId" TEXT,
    "sourceMessageId"      TEXT,
    "lastAccessedAt"       TIMESTAMP(3),
    "accessCount"          INTEGER NOT NULL DEFAULT 0,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Memory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Memory_userId_agentId_createdAt_idx"
    ON "Memory"("userId", "agentId", "createdAt");

CREATE INDEX "Memory_userId_category_idx"
    ON "Memory"("userId", "category");

-- ---------------------------------------------------------------------------
-- MemoryLink（记忆关联，3D 网络连线）
-- ---------------------------------------------------------------------------

CREATE TABLE "MemoryLink" (
    "id"       TEXT NOT NULL,
    "userId"   TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "weight"   DOUBLE PRECISION NOT NULL DEFAULT 1.0,

    CONSTRAINT "MemoryLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MemoryLink_sourceId_targetId_key"
    ON "MemoryLink"("sourceId", "targetId");

CREATE INDEX "MemoryLink_userId_idx" ON "MemoryLink"("userId");

-- ---------------------------------------------------------------------------
-- MemorySetting（记忆生成 / 召回偏好，按用户）
-- ---------------------------------------------------------------------------

CREATE TABLE "MemorySetting" (
    "id"                 TEXT NOT NULL,
    "userId"             TEXT NOT NULL,
    "autoCaptureEnabled" BOOLEAN NOT NULL DEFAULT true,
    "captureModelId"     TEXT,
    "recallLimit"        INTEGER NOT NULL DEFAULT 6,
    "updatedAt"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemorySetting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MemorySetting_userId_key" ON "MemorySetting"("userId");

-- ---------------------------------------------------------------------------
-- RefreshToken（桌宠短时效凭证）
-- ---------------------------------------------------------------------------

CREATE TABLE "RefreshToken" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scope"     TEXT NOT NULL DEFAULT 'DESKTOP',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");
