import { PrismaClient } from "@prisma/client";
import moment from "moment-timezone";
import cron from "node-cron";

import { nextInsideWindowUnixQuebec } from "./lib/schedule.js";
import { nextDayInsideWindowUnix } from "./routes/webhooks.js";
import { findNextSlot } from "./routes/intake.js";
import { QUEBEC_TZ } from "./lib/quebecTime.js";

const prisma = new PrismaClient();

async function detectAndRescheduleAnomalies() {
  const now = moment().tz(QUEBEC_TZ);
  console.log(`Running at ${now.format("YYYY-MM-DD HH:mm:ss z")}`);

  const anomalies = await prisma.callAttempt.findMany({
    where: {
      status: "SCHEDULED",
      scheduledAt: { lt: now.toDate() },
      attemptNumber: 1,
    },
    include: { Lead: true },
  });
  console.log(
    `Found ${anomalies.length} anomalies:`,
    anomalies.map((a) => `Lead ${a.Lead.id}`).join(", ")
  );

  for (const [index, attempt] of anomalies.entries()) {
    const lead = attempt.Lead;
    console.log(
      `Processing lead ${lead.id}, attempt ${
        attempt.id
      }, current scheduledAt: ${moment(attempt.scheduledAt)
        .tz(QUEBEC_TZ)
        .format("YYYY-MM-DD HH:mm:ss z")}`
    );
    const tz = lead.timezone || QUEBEC_TZ;
    let nextScheduledUnix = nextInsideWindowUnixQuebec(tz);
    console.log(
      `Initial nextScheduledUnix: ${moment
        .unix(nextScheduledUnix)
        .tz(tz)
        .format("YYYY-MM-DD HH:mm:ss z")}`
    );

    const currentWindowStart = moment().tz(tz).hour(9).minute(0).second(0);
    const currentWindowEnd = moment().tz(tz).hour(19).minute(0).second(0);
    if (now.isBetween(currentWindowStart, currentWindowEnd)) {
      nextScheduledUnix = now.unix() + 120 + index * 300; // 2 min + 5 min stagger
      if (moment.unix(nextScheduledUnix).tz(tz).isAfter(currentWindowEnd)) {
        nextScheduledUnix = currentWindowStart.unix() + index * 300; // Reset to start of window
      }
      console.log(
        `Within window, adjusted to: ${moment
          .unix(nextScheduledUnix)
          .tz(tz)
          .format("YYYY-MM-DD HH:mm:ss z")}`
      );
    }

    const startUnix = moment().tz(tz).hour(9).minute(0).second(0).unix();
    const endUnix = moment().tz(tz).hour(19).minute(0).second(0).unix();
    let scheduledUnix = await findNextSlot(nextScheduledUnix, endUnix, tz);
    console.log(
      `After findNextSlot for lead ${lead.id}: ${moment
        .unix(scheduledUnix)
        .tz(tz)
        .format("YYYY-MM-DD HH:mm:ss z")}, existing slots:`,
      await prisma.callAttempt.findMany({ where: { status: "SCHEDULED" } })
    );

    // Fallback overlap check
    const existingSlots = await prisma.callAttempt.findMany({
      where: {
        scheduledAt: {
          gte: moment.unix(scheduledUnix - 300).toDate(),
          lte: moment.unix(scheduledUnix + 300).toDate(),
        },
        status: "SCHEDULED",
      },
    });
    if (existingSlots.length > 0) {
      console.log(
        `Overlap detected for lead ${lead.id} with ${existingSlots.length} slots, adjusting...`
      );
      scheduledUnix += 300; // Add 5-minute gap
      while (
        (await prisma.callAttempt.count({
          where: {
            scheduledAt: {
              gte: moment.unix(scheduledUnix - 300).toDate(),
              lte: moment.unix(scheduledUnix + 300).toDate(),
            },
            status: "SCHEDULED",
          },
        })) > 0
      ) {
        scheduledUnix += 300;
      }
      console.log(
        `Adjusted to new slot: ${moment
          .unix(scheduledUnix)
          .tz(tz)
          .format("YYYY-MM-DD HH:mm:ss z")}`
      );
    }

    if (
      moment
        .unix(scheduledUnix)
        .tz(tz)
        .isAfter(moment().tz(tz).hour(19).minute(0).second(0))
    ) {
      scheduledUnix = nextDayInsideWindowUnix(tz);
      console.log(
        `Exceeded window, using next day: ${moment
          .unix(scheduledUnix)
          .tz(tz)
          .format("YYYY-MM-DD HH:mm:ss z")}`
      );
    }

    const scheduledAt = moment.unix(scheduledUnix).toDate();
    const maxAttempts = lead.maxAttempts || 3;
    console.log(
      `Final scheduledAt for lead ${lead.id}: ${moment(scheduledAt)
        .tz(tz)
        .format(
          "YYYY-MM-DD HH:mm:ss z"
        )}, maxAttempts: ${maxAttempts}, current attempts: ${lead.attempts}`
    );

    if (lead.attempts + 1 < maxAttempts) {
      try {
        await prisma.$transaction(async (tx) => {
          await tx.callAttempt.update({
            where: { id: attempt.id },
            data: { scheduledAt: scheduledAt, attemptNumber: 2 },
          });
          await tx.lead.update({
            where: { id: lead.id },
            data: {
              status: "SCHEDULED",
              attempts: attempt.attemptNumber, // Sync with attemptNumber
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
    } else {
      await prisma.lead.update({
        where: { id: lead.id },
        data: { status: "FAILED" },
      });
      console.log(`Max attempts reached for lead ${lead.id}, set to FAILED`);
    }
  }
}

cron.schedule("*/5 * * * *", () => detectAndRescheduleAnomalies());
detectAndRescheduleAnomalies().catch((error) =>
  console.error(`Cron error: ${error.message}`)
);
