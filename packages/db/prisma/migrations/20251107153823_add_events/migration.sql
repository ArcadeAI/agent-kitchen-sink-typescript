-- CreateTable
CREATE TABLE "event" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "step" TEXT,
    "stepIndex" INTEGER,
    "data" JSONB,
    "state" JSONB,
    "error" TEXT,
    "timestamp" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "event_sessionId_timestamp_idx" ON "event"("sessionId", "timestamp");

-- CreateIndex
CREATE INDEX "event_sessionId_createdAt_idx" ON "event"("sessionId", "createdAt");

-- AddForeignKey
ALTER TABLE "event" ADD CONSTRAINT "event_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "agent_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
