/*
  Warnings:

  - You are about to drop the column `conversationId` on the `CallAttempt` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[phoneNumberId]` on the table `Agent` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[conversationExternalId]` on the table `CallAttempt` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "CallAttempt" DROP CONSTRAINT "CallAttempt_leadId_fkey";

-- DropForeignKey
ALTER TABLE "Conversation" DROP CONSTRAINT "Conversation_leadId_fkey";

-- DropForeignKey
ALTER TABLE "Message" DROP CONSTRAINT "Message_conversationId_fkey";

-- DropIndex
DROP INDEX "CallAttempt_conversationId_key";

-- AlterTable
ALTER TABLE "CallAttempt" DROP COLUMN "conversationId",
ADD COLUMN     "conversationExternalId" TEXT;

-- CreateTable
CREATE TABLE "NotificationEvent" (
    "id" SERIAL NOT NULL,
    "leadId" INTEGER NOT NULL,
    "step" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scheduledAt" TIMESTAMP(3),
    "metadata" JSONB,

    CONSTRAINT "NotificationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NotificationEvent_leadId_createdAt_idx" ON "NotificationEvent"("leadId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_phoneNumberId_key" ON "Agent"("phoneNumberId");

-- CreateIndex
CREATE UNIQUE INDEX "CallAttempt_conversationExternalId_key" ON "CallAttempt"("conversationExternalId");

-- CreateIndex
CREATE INDEX "CallAttempt_scheduledAt_idx" ON "CallAttempt"("scheduledAt");

-- CreateIndex
CREATE INDEX "Lead_createdAt_idx" ON "Lead"("createdAt");

-- CreateIndex
CREATE INDEX "Message_createdAt_idx" ON "Message"("createdAt");

-- AddForeignKey
ALTER TABLE "CallAttempt" ADD CONSTRAINT "CallAttempt_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationEvent" ADD CONSTRAINT "NotificationEvent_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
