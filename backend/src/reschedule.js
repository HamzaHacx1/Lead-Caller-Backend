import { PrismaClient } from "@prisma/client";
import moment from "moment-timezone";
import cron from "node-cron";

import { QUEBEC_TZ } from "./lib/quebecTime.js";

const prisma = new PrismaClient();

async function detectAndRescheduleAnomalies() {
  const now = moment().tz(QUEBEC_TZ);
  console.log(`Running at ${now.format("YYYY-MM-DD HH:mm:ss z")}`);

  // Check for overdue SCHEDULED attempts (any attempt number)
  const overdueAttempts = await prisma.callAttempt.findMany({
    where: {
      status: "SCHEDULED",
      scheduledAt: { lt: now.toDate() },
    },
    include: { Lead: true },
  });

  // Check for overdue FAILED leads with max attempts
  const overdueFailedLeads = await prisma.lead.findMany({
    where: {
      nextScheduledAt: { lt: now.toDate() },
      attempts: { gte: 3 }, // Assuming maxAttempts is 3
      status: "FAILED",
    },
    include: { callAttempts: true },
  });

  const allTargets = [
    ...overdueAttempts,
    ...overdueFailedLeads.flatMap((l) => l.callAttempts),
  ];

  for (const [index, attempt] of allTargets.entries()) {
    const lead =
      attempt.Lead ||
      overdueFailedLeads.find((l) => l.id === attempt.leadId)?.Lead;
    if (!lead) continue;

    console.log(
      `Processing lead ${lead.id}, attempt ${
        attempt.id
      }, current scheduledAt: ${moment(attempt.scheduledAt)
        .tz(QUEBEC_TZ)
        .format("YYYY-MM-DD HH:mm:ss z")}`
    );

    let nextScheduledUnix = now.unix() + 30 + index * 300; // 30s delay + 5m stagger
    const utcNow = moment().utc();

    // Block weekends (Saturday=6, Sunday=0 in UTC)
    if (utcNow.day() === 0 || utcNow.day() === 6) {
      nextScheduledUnix = utcNow
        .add(2, "days")
        .hour(9)
        .minute(0)
        .second(0)
        .unix(); // Next Monday 9 AM UTC
    }

    const scheduledAt = moment.unix(nextScheduledUnix).toDate();
    const maxAttempts = lead.maxAttempts || 3;

    if (lead.attempts >= maxAttempts) {
      await prisma.lead.update({
        where: { id: lead.id },
        data: { attempts: 0, status: "SCHEDULED" }, // Reset for retry
      });
    }

    try {
      await prisma.$transaction(async (tx) => {
        await tx.callAttempt.update({
          where: { id: attempt.id },
          data: { scheduledAt, attemptNumber: lead.attempts + 1 },
        });
        await tx.lead.update({
          where: { id: lead.id },
          data: {
            status: "SCHEDULED",
            attempts: lead.attempts + 1,
            nextScheduledAt: scheduledAt,
          },
        });
      });
      console.log(
        `Successfully rescheduled lead ${lead.id} to ${moment(scheduledAt)
          .tz(QUEBEC_TZ)
          .format("YYYY-MM-DD HH:mm:ss z")}`
      );
    } catch (error) {
      console.error(`Failed to reschedule lead ${lead.id}: ${error.message}`);
    }
  }
}

cron.schedule("*/5 * * * *", () => detectAndRescheduleAnomalies());
detectAndRescheduleAnomalies().catch((error) =>
  console.error(`Cron error: ${error.message}`)
);
