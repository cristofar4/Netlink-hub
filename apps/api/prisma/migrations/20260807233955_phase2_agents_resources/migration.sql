-- CreateEnum
CREATE TYPE "ResourceKind" AS ENUM ('folder', 'printer');

-- CreateTable
CREATE TABLE "agent_enrollment_tokens" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_enrollment_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_nonces" (
    "nonce" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "request_nonces_pkey" PRIMARY KEY ("nonce")
);

-- CreateTable
CREATE TABLE "resources" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "kind" "ResourceKind" NOT NULL,
    "name" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_enrollment_tokens_tokenHash_key" ON "agent_enrollment_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "agent_enrollment_tokens_spaceId_idx" ON "agent_enrollment_tokens"("spaceId");

-- CreateIndex
CREATE INDEX "request_nonces_expiresAt_idx" ON "request_nonces"("expiresAt");

-- CreateIndex
CREATE INDEX "resources_spaceId_kind_idx" ON "resources"("spaceId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "resources_agentId_kind_target_key" ON "resources"("agentId", "kind", "target");

-- AddForeignKey
ALTER TABLE "agent_enrollment_tokens" ADD CONSTRAINT "agent_enrollment_tokens_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resources" ADD CONSTRAINT "resources_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resources" ADD CONSTRAINT "resources_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
