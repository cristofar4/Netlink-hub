-- CreateEnum
CREATE TYPE "PowerCommandState" AS ENUM ('pending', 'countdown', 'sent', 'acknowledged', 'succeeded', 'failed', 'cancelled', 'expired');

-- CreateTable
CREATE TABLE "power_commands" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "targetAgentId" TEXT NOT NULL,
    "helperAgentId" TEXT,
    "action" TEXT NOT NULL,
    "state" "PowerCommandState" NOT NULL DEFAULT 'pending',
    "requestedById" TEXT NOT NULL,
    "requestedByDeviceId" TEXT,
    "nonce" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "executeAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "power_commands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "power_commands_nonce_key" ON "power_commands"("nonce");

-- CreateIndex
CREATE INDEX "power_commands_targetAgentId_state_idx" ON "power_commands"("targetAgentId", "state");

-- CreateIndex
CREATE INDEX "power_commands_spaceId_createdAt_idx" ON "power_commands"("spaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "power_commands" ADD CONSTRAINT "power_commands_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "power_commands" ADD CONSTRAINT "power_commands_targetAgentId_fkey" FOREIGN KEY ("targetAgentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "power_commands" ADD CONSTRAINT "power_commands_helperAgentId_fkey" FOREIGN KEY ("helperAgentId") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
