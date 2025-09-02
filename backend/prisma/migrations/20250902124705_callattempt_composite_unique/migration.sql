/*
  Warnings:

  - A unique constraint covering the columns `[leadId,attemptNumber]` on the table `CallAttempt` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "CallAttempt_leadId_attemptNumber_key" ON "CallAttempt"("leadId", "attemptNumber");
