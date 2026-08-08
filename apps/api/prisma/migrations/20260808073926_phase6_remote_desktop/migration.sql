-- CreateEnum
CREATE TYPE "RemoteSessionMode" AS ENUM ('view', 'control');

-- CreateEnum
CREATE TYPE "RemoteSessionState" AS ENUM ('pending', 'connecting', 'active', 'ended');

-- CreateEnum
CREATE TYPE "SignalRole" AS ENUM ('viewer', 'host');

-- CreateTable
CREATE TABLE "remote_sessions" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "viewerId" TEXT NOT NULL,
    "viewerDeviceId" TEXT,
    "mode" "RemoteSessionMode" NOT NULL,
    "state" "RemoteSessionState" NOT NULL DEFAULT 'pending',
    "nonce" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "connectedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "strategy" TEXT NOT NULL DEFAULT 'unknown',
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "refusedInputs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "remote_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "remote_signals" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "from" "SignalRole" NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "remote_signals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "remote_sessions_nonce_key" ON "remote_sessions"("nonce");

-- CreateIndex
CREATE INDEX "remote_sessions_agentId_state_idx" ON "remote_sessions"("agentId", "state");

-- CreateIndex
CREATE INDEX "remote_sessions_spaceId_createdAt_idx" ON "remote_sessions"("spaceId", "createdAt");

-- CreateIndex
CREATE INDEX "remote_sessions_viewerId_state_idx" ON "remote_sessions"("viewerId", "state");

-- CreateIndex
CREATE INDEX "remote_signals_sessionId_seq_idx" ON "remote_signals"("sessionId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "remote_signals_sessionId_seq_key" ON "remote_signals"("sessionId", "seq");

-- AddForeignKey
ALTER TABLE "remote_sessions" ADD CONSTRAINT "remote_sessions_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remote_sessions" ADD CONSTRAINT "remote_sessions_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remote_sessions" ADD CONSTRAINT "remote_sessions_viewerId_fkey" FOREIGN KEY ("viewerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remote_signals" ADD CONSTRAINT "remote_signals_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "remote_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
