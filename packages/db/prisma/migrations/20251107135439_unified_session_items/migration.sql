-- CreateTable
CREATE TABLE "session_item" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "timestamp" BIGINT NOT NULL,
    "role" TEXT,
    "content" TEXT,
    "step" TEXT,
    "stepIndex" INTEGER,
    "data" JSONB,
    "state" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "session_item_sessionId_timestamp_idx" ON "session_item"("sessionId", "timestamp");

-- CreateIndex
CREATE INDEX "session_item_sessionId_type_idx" ON "session_item"("sessionId", "type");

-- AddForeignKey
ALTER TABLE "session_item" ADD CONSTRAINT "session_item_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "agent_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Migrate data from message table
INSERT INTO "session_item" (
    "id",
    "sessionId",
    "type",
    "timestamp",
    "role",
    "content",
    "data",
    "createdAt"
)
SELECT
    m."id",
    m."sessionId",
    CASE 
        WHEN m."role" = 'user' THEN 'user_message'
        WHEN m."role" = 'assistant' THEN 'assistant_message'
        WHEN m."role" = 'system' THEN 'system_message'
        ELSE 'user_message'
    END,
    EXTRACT(EPOCH FROM m."createdAt")::BIGINT * 1000,
    m."role",
    m."content",
    m."metadata",
    m."createdAt"
FROM "message" m;

-- Migrate data from event table
INSERT INTO "session_item" (
    "id",
    "sessionId",
    "type",
    "timestamp",
    "step",
    "stepIndex",
    "data",
    "state",
    "error",
    "createdAt"
)
SELECT
    e."id",
    e."sessionId",
    e."type",
    e."timestamp",
    e."step",
    e."stepIndex",
    e."data",
    e."state",
    e."error",
    e."createdAt"
FROM "event" e;

-- DropForeignKey
ALTER TABLE "message" DROP CONSTRAINT "message_sessionId_fkey";

-- DropForeignKey
ALTER TABLE "event" DROP CONSTRAINT "event_sessionId_fkey";

-- DropTable
DROP TABLE "message";

-- DropTable
DROP TABLE "event";

