-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "mediaContentTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "mediaUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "readAt" TIMESTAMP(3),
ALTER COLUMN "body" SET DEFAULT '';

-- CreateIndex
CREATE INDEX "Message_conversationId_id_idx" ON "Message"("conversationId", "id");
