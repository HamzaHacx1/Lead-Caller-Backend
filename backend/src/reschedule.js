import { PrismaClient } from "@prisma/client";
import moment from "moment-timezone";
import cron from "node-cron";

import { nextInsideWindowUnix, START, END, pickTz } from "./lib/schedule.js";
import { QUEBEC_TZ, nowIn } from "./lib/quebecTime.js";

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

  // Overdue scheduled attempts
  const overdueAttempts = await prisma.callAttempt.findMany({
    where: { status: "SCHEDULED", scheduledAt: { lt: utcNow.toDate() } },
    include: { lead: true },
    take: 200,
  });

  // Leads that failed but should be reset
  const overdueFailedLeads = await prisma.lead.findMany({
    where: {
      nextScheduledAt: { lt: utcNow.toDate() },
      attempts: { gte: 3 },
      status: "FAILED",
    },
    include: { callAttempts: true },
    take: 200,
  });

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

  const groups = new Map();

  for (const attempt of attemptsSorted) {
    const lead =
      attempt.lead ||
      (await prisma.lead.findUnique({ where: { id: attempt.leadId } }));
    if (!lead) continue;

    const tz = pickTz(lead.timezone);
    const nextUnix = await nextInsideWindowUnix(tz); // ⬅️ FIX: await

    if (!groups.has(nextUnix)) groups.set(nextUnix, []);
    groups.get(nextUnix).push({ attempt, lead });
  }

  for (const [nextUnix, group] of groups.entries()) {
    // stagger logic if multiple attempts need same slot
    group.sort(
      (a, b) =>
        new Date(a.attempt.scheduledAt) - new Date(b.attempt.scheduledAt)
    );

    let idx = 0;

    for (const { attempt, lead } of group) {
      const tz = pickTz(lead.timezone);
      let slot = moment.unix(nextUnix).tz(tz);
      const endCap = slot.clone().hour(END).minute(0).second(0);

      const stagger = idx * 300; // 5min spacing
      const cand = slot.clone().add(stagger, "seconds");
      slot = cand.isSameOrBefore(endCap) ? cand : endCap;
      idx++;

      const scheduledAt = slot.toDate();

      try {
        if (
          lead.status === "FAILED" &&
          lead.attempts >= (lead.maxAttempts ?? 3)
        ) {
          // Reset lead → new attempt #1
          await prisma.$transaction([
            prisma.lead.update({
              where: { id: lead.id },
              data: {
                status: "SCHEDULED",
                attempts: 1,
                nextScheduledAt: scheduledAt,
              },
            }),
            prisma.callAttempt.create({
              data: {
                leadId: lead.id,
                attemptNumber: 1,
                status: "SCHEDULED",
                scheduledAt,
              },
            }),
          ]);
        } else {
          // Just bump scheduled time, keep attemptNumber
          await prisma.$transaction([
            prisma.callAttempt.update({
              where: { id: attempt.id },
              data: { scheduledAt },
            }),
            prisma.lead.update({
              where: { id: lead.id },
              data: {
                status: "SCHEDULED",
                nextScheduledAt: scheduledAt,
              },
            }),
          ]);
        }

        console.log(
          `Rescheduled lead ${lead.id} → ${moment(scheduledAt)
            .tz(tz)
            .format("YYYY-MM-DD HH:mm:ss z")} (tz=${tz})`
        );
      } catch (err) {
        console.error(`Failed to reschedule lead ${lead.id}: ${err.message}`);
      }
    }
  }
}

// Québec timezone cron (every 5 min)
cron.schedule("*/5 * * * *", () => detectAndRescheduleAnomalies(), {
  timezone: QUEBEC_TZ,
});

// Run once on boot
detectAndRescheduleAnomalies().catch((e) =>
  console.error(`Cron error: ${e.message}`)
);
