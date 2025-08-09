-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'SCHEDULED', 'IN_PROGRESS', 'ANSWERED', 'VOICEMAIL', 'NO_ANSWER', 'FAILED', 'ERROR', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AttemptOutcome" AS ENUM ('SCHEDULED', 'ANSWERED', 'VOICEMAIL', 'NO_ANSWER', 'FAILED', 'CANCELED');

-- CreateTable
CREATE TABLE "Agent" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "elevenAgentId" TEXT NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" SERIAL NOT NULL,
    "fbLeadId" TEXT,
    "fullName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'facebook_lead_ads',
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastOutcome" "AttemptOutcome",
    "lastAttemptAt" TIMESTAMP(3),
    "createdUserId" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallAttempt" (
    "id" SERIAL NOT NULL,
    "leadId" INTEGER NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "status" "AttemptOutcome" NOT NULL DEFAULT 'SCHEDULED',
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "conversationId" TEXT,
    "recordingUrl" TEXT,
    "transcript" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'admin',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Agent_elevenAgentId_key" ON "Agent"("elevenAgentId");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_fbLeadId_key" ON "Lead"("fbLeadId");

-- CreateIndex
CREATE UNIQUE INDEX "CallAttempt_conversationId_key" ON "CallAttempt"("conversationId");

-- CreateIndex
CREATE INDEX "CallAttempt_leadId_idx" ON "CallAttempt"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- AddForeignKey
ALTER TABLE "CallAttempt" ADD CONSTRAINT "CallAttempt_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
