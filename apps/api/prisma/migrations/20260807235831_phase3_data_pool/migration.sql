-- CreateEnum
CREATE TYPE "AllocationStatus" AS ENUM ('active', 'paused', 'expired', 'revoked');

-- CreateTable
CREATE TABLE "data_pools" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'demo',
    "accountRef" TEXT NOT NULL,
    "planName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_pools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_allocations" (
    "id" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "status" "AllocationStatus" NOT NULL DEFAULT 'active',
    "totalBytes" DECIMAL(20,0) NOT NULL,
    "dailyBytes" DECIMAL(20,0),
    "usedBytes" DECIMAL(20,0) NOT NULL DEFAULT 0,
    "usedTodayBytes" DECIMAL(20,0) NOT NULL DEFAULT 0,
    "usageDay" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "allowResharing" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "pausedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "data_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_usage_events" (
    "id" TEXT NOT NULL,
    "allocationId" TEXT NOT NULL,
    "bytes" DECIMAL(20,0) NOT NULL,
    "sessionSeconds" INTEGER NOT NULL DEFAULT 0,
    "deviceId" TEXT,
    "providerRef" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "data_pools_spaceId_key" ON "data_pools"("spaceId");

-- CreateIndex
CREATE UNIQUE INDEX "data_allocations_memberId_key" ON "data_allocations"("memberId");

-- CreateIndex
CREATE INDEX "data_allocations_spaceId_status_idx" ON "data_allocations"("spaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "data_usage_events_providerRef_key" ON "data_usage_events"("providerRef");

-- CreateIndex
CREATE INDEX "data_usage_events_allocationId_occurredAt_idx" ON "data_usage_events"("allocationId", "occurredAt");

-- AddForeignKey
ALTER TABLE "data_pools" ADD CONSTRAINT "data_pools_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_allocations" ADD CONSTRAINT "data_allocations_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "data_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_allocations" ADD CONSTRAINT "data_allocations_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "space_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_usage_events" ADD CONSTRAINT "data_usage_events_allocationId_fkey" FOREIGN KEY ("allocationId") REFERENCES "data_allocations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
