/*
  Warnings:

  - You are about to drop the column `chequeUploaded` on the `User` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "public"."Lead" ADD COLUMN     "chequeUploaded" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "public"."User" DROP COLUMN "chequeUploaded";
