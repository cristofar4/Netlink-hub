-- CreateEnum
CREATE TYPE "TransferDirection" AS ENUM ('download', 'upload');

-- CreateEnum
CREATE TYPE "TransferState" AS ENUM ('pending', 'active', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "PrintJobState" AS ENUM ('queued', 'sent', 'printing', 'completed', 'failed');

-- CreateTable
CREATE TABLE "file_transfers" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "direction" "TransferDirection" NOT NULL,
    "path" TEXT NOT NULL,
    "state" "TransferState" NOT NULL DEFAULT 'pending',
    "sizeBytes" DECIMAL(20,0),
    "transferredBytes" DECIMAL(20,0) NOT NULL DEFAULT 0,
    "checksum" TEXT,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "file_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "print_jobs" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "printerName" TEXT NOT NULL,
    "documentName" TEXT NOT NULL,
    "document" TEXT,
    "copies" INTEGER NOT NULL DEFAULT 1,
    "colour" BOOLEAN NOT NULL DEFAULT true,
    "paperSize" TEXT NOT NULL DEFAULT 'A4',
    "state" "PrintJobState" NOT NULL DEFAULT 'queued',
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "collectedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "print_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "file_transfers_spaceId_createdAt_idx" ON "file_transfers"("spaceId", "createdAt");

-- CreateIndex
CREATE INDEX "file_transfers_agentId_state_idx" ON "file_transfers"("agentId", "state");

-- CreateIndex
CREATE INDEX "print_jobs_agentId_state_idx" ON "print_jobs"("agentId", "state");

-- CreateIndex
CREATE INDEX "print_jobs_spaceId_createdAt_idx" ON "print_jobs"("spaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "file_transfers" ADD CONSTRAINT "file_transfers_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_transfers" ADD CONSTRAINT "file_transfers_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "resources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "resources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
