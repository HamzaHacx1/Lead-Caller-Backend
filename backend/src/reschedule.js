import { PrismaClient } from "@prisma/client";
import moment from "moment-timezone";
import cron from "node-cron";

import { nextInsideWindowUnix, START, END, pickTz } from "./lib/schedule.js";
import { QUEBEC_TZ, nowIn, formatInQuebec } from "./lib/quebecTime.js";

const prisma = new PrismaClient();

function logNow() {
  const nowQc = nowIn(QUEBEC_TZ);
  console.log(
    `Running at ${nowQc.format("YYYY-MM-DD HH:mm:ss z")} [UTC: ${moment
      .utc()
      .format()}], window ${START}:00–${END}:00`
  );
}

async function detectAndRescheduleAnomalies() {
  logNow();

  const utcNow = moment.utc();

  const overdueAttempts = await prisma.callAttempt.findMany({
    where: { status: "SCHEDULED", scheduledAt: { lt: utcNow.toDate() } },
    include: { lead: true },
    take: 200,
  });

  const overdueFailedLeads = await prisma.lead.findMany({
    where: {
      nextScheduledAt: { lt: utcNow.toDate() },
      attempts: { gte: 3 },
      status: "FAILED",
    },
    include: { callAttempts: true },
    take: 200,
  });

  // Flatten to attempts and de-dup by id; sort by previous scheduledAt
  const allTargets = [
    ...overdueAttempts,
    ...overdueFailedLeads.flatMap((l) => l.callAttempts || []),
  ]
    .filter(Boolean)
    .reduce((map, a) => map.set(a.id, a), new Map())
    .values();

  const attemptsSorted = [...allTargets].sort(
    (a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt)
  );

  if (attemptsSorted.length === 0) {
    console.log("No overdue attempts or failed leads to process.");
    return;
  }

  let dayIndex = 0; // stagger index only for today within window

  for (const attempt of attemptsSorted) {
    const lead =
      attempt.lead ||
      (await prisma.lead.findUnique({ where: { id: attempt.leadId } }));
    if (!lead) continue;

    const tz = pickTz(lead.timezone);
    const nextUnix = nextInsideWindowUnix(tz);
    let slot = moment.unix(nextUnix).tz(tz);

    // Stagger 5-min slots but NEVER push past END
    const endCap = slot.clone().hour(END).minute(0).second(0).millisecond(0);
    if (
      slot.isSame(nowIn(tz), "day") &&
      slot.hour() >= START &&
      slot.hour() < END
    ) {
      const stagger = dayIndex * 300; // seconds
      const cand = slot.clone().add(stagger, "seconds");
      slot = cand.isSameOrBefore(endCap) ? cand : endCap; // clamp
      dayIndex += 1;
    } else {
      dayIndex = 0; // reset for next day
    }

    const scheduledAt = slot.toDate();
    const maxAttempts = lead.maxAttempts ?? 3;
    const nextAttemptNumber = (attempt.attemptNumber ?? 0) + 1;

    // Reset FAILED leads that are overdue
    if (lead.status === "FAILED" && lead.attempts >= maxAttempts) {
      await prisma.lead.update({
        where: { id: lead.id },
        data: { attempts: 0, status: "SCHEDULED" },
      });
    }

    try {
      await prisma.$transaction([
        prisma.callAttempt.update({
          where: { id: attempt.id },
          data: { scheduledAt, attemptNumber: nextAttemptNumber },
        }),
        prisma.lead.update({
          where: { id: lead.id },
          data: {
            status: "SCHEDULED",
            attempts: (lead.attempts ?? 0) + 1,
            nextScheduledAt: scheduledAt,
          },
        }),
      ]);

      console.log(
        `Successfully rescheduled lead ${lead.id} to ${moment(scheduledAt)
          .tz(tz)
          .format("YYYY-MM-DD HH:mm:ss z")} (tz=${tz})`
      );
    } catch (err) {
      console.error(`Failed to reschedule lead ${lead.id}: ${err.message}`);
    }
  }
}

// ⬇️ Pin the cron to Québec time (important)
cron.schedule("*/5 * * * *", () => detectAndRescheduleAnomalies(), {
  timezone: QUEBEC_TZ,
});

// Run once on boot
detectAndRescheduleAnomalies().catch((e) =>
  console.error(`Cron error: ${e.message}`)
);
