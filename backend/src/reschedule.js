import { PrismaClient } from "@prisma/client";
import moment from "moment-timezone";
import cron from "node-cron";

import {
  getQuebecNow,
  isQuebecWeekend,
  getNextQuebecWeekdayUnix,
} from "./lib/quebecTime.js";
import { nextInsideWindowUnix, QUEBEC_TZ } from "./lib/schedule.js";

const prisma = new PrismaClient();

async function detectAndRescheduleAnomalies() {
  const now = moment().tz(QUEBEC_TZ);
  const utcNow = moment().utc();
  console.log(
    `Running at ${now.format(
      "YYYY-MM-DD HH:mm:ss z"
    )} [UTC: ${utcNow.format()}]`
  );

  try {
    const overdueAttempts = await prisma.callAttempt.findMany({
      where: {
        status: "SCHEDULED",
        scheduledAt: { lt: utcNow.toDate() },
      },
      include: { lead: true },
      take: 100, // Limit to prevent overload
    });

    const overdueFailedLeads = await prisma.lead.findMany({
      where: {
        nextScheduledAt: { lt: utcNow.toDate() },
        attempts: { gte: 3 },
        status: "FAILED",
      },
      include: { callAttempts: true },
      take: 100,
    });

    const allTargets = [
      ...overdueAttempts,
      ...overdueFailedLeads.flatMap((l) => l.callAttempts),
    ].filter((a) => a);

    if (allTargets.length === 0) {
      console.log("No overdue attempts or failed leads to process.");
      return;
    }

    for (const [index, attempt] of allTargets.entries()) {
      if (index >= 100) {
        console.warn(
          "Max reschedule limit reached, skipping remaining attempts"
        );
        break;
      }
      const lead =
        attempt.lead ||
        overdueFailedLeads.find((l) => l.id === attempt.leadId)?.lead;
      if (!lead) continue;

      console.log(
        `Processing lead ${lead.id}, attempt ${
          attempt.id
        }, current scheduledAt: ${moment(attempt.scheduledAt)
          .tz(QUEBEC_TZ)
          .format("YYYY-MM-DD HH:mm:ss z")}`
      );

      const tz = lead.timezone || QUEBEC_TZ;
      let nextScheduledUnix = await nextInsideWindowUnix(tz); // Respect 9 AM–7 PM window

      // Apply stagger only within the same day window
      const slotMoment = moment.unix(nextScheduledUnix).tz(tz);
      if (
        slotMoment.isSame(now, "day") &&
        slotMoment.hour() >= 9 &&
        slotMoment.hour() < 19
      ) {
        nextScheduledUnix += index * 300; // 5-minute stagger
      }

      const scheduledAt = moment.unix(nextScheduledUnix).tz(tz).toDate();
      const maxAttempts = lead.maxAttempts || 3;

      if (
        lead.attempts >= maxAttempts ||
        moment(lead.nextScheduledAt).isBefore(now)
      ) {
        await prisma.lead.update({
          where: { id: lead.id },
          data: { attempts: 0, status: "SCHEDULED" },
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
            .tz(tz)
            .format("YYYY-MM-DD HH:mm:ss z")}`
        );
      } catch (error) {
        console.error(`Failed to reschedule lead ${lead.id}: ${error.message}`);
      }
    }
  } catch (error) {
    console.error(`Cron error: ${error.message}`);
  }
}

cron.schedule("*/5 * * * *", () => detectAndRescheduleAnomalies());
detectAndRescheduleAnomalies().catch((error) =>
  console.error(`Cron error: ${error.message}`)
);
