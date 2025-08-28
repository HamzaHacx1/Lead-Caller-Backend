-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "lastProcessedAt" TIMESTAMP(3),
ADD COLUMN     "maxAttempts" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "nextScheduledAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Lead_status_nextScheduledAt_idx" ON "Lead"("status", "nextScheduledAt");
