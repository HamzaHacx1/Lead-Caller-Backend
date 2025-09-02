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

  // Group by initial nextUnix
  const groups = new Map();

  for (const attempt of attemptsSorted) {
    const lead =
      attempt.lead ||
      (await prisma.lead.findUnique({ where: { id: attempt.leadId } }));
    if (!lead) continue;

    const tz = pickTz(lead.timezone);
    const nextUnix = nextInsideWindowUnix(tz);

    if (!groups.has(nextUnix)) groups.set(nextUnix, []);
    groups.get(nextUnix).push({ attempt, lead });
  }

  for (const [nextUnix, group] of groups.entries()) {
    if (group.length < 2) {
      // No stagger needed for single
      for (const { attempt, lead } of group) {
        const tz = pickTz(lead.timezone);
        const scheduledAt = moment.unix(nextUnix).tz(tz).toDate();
        const maxAttempts = lead.maxAttempts ?? 3;
        const nextAttemptNumber = (lead.attempts ?? 0) + 1;

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
      continue;
    }

    // Sort group by previous scheduledAt
    group.sort(
      (a, b) =>
        new Date(a.attempt.scheduledAt) - new Date(b.attempt.scheduledAt)
    );

    let dayIndex = 0;

    for (const { attempt, lead } of group) {
      const tz = pickTz(lead.timezone);
      let slot = moment.unix(nextUnix).tz(tz);

      const endCap = slot.clone().hour(END).minute(0).second(0).millisecond(0);

      const stagger = dayIndex * 300; // seconds
      const cand = slot.clone().add(stagger, "seconds");
      slot = cand.isSameOrBefore(endCap) ? cand : endCap; // clamp

      dayIndex += 1;

      const scheduledAt = slot.toDate();
      const maxAttempts = lead.maxAttempts ?? 3;
      const nextAttemptNumber = (lead.attempts ?? 0) + 1;

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
}

// ⬇️ Pin the cron to Québec time (important)
cron.schedule("*/5 * * * *", () => detectAndRescheduleAnomalies(), {
  timezone: QUEBEC_TZ,
});

// Run once on boot
detectAndRescheduleAnomalies().catch((e) =>
  console.error(`Cron error: ${e.message}`)
);
