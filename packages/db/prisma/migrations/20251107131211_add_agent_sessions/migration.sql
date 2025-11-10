-- CreateTable
CREATE TABLE "agent_session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "stateData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_session_userId_agentId_idx" ON "agent_session"("userId", "agentId");

-- CreateIndex
CREATE INDEX "agent_session_userId_status_idx" ON "agent_session"("userId", "status");

-- CreateIndex
CREATE INDEX "message_sessionId_createdAt_idx" ON "message"("sessionId", "createdAt");

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "agent_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
