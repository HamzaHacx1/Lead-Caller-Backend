import moment from "moment-timezone";
import cron from "node-cron";

import {
  START,
  END,
  pickTz,
  nextInsideWindowUnix, // sync
  rollForwardToWindowUnix, // for safety clamp
  ceilToSlotUnix, // align to 5-min
} from "./lib/schedule.js";
import { QUEBEC_TZ, nowIn } from "./lib/quebecTime.js";
// cron/reschedule-anomalies.js
import prisma from "./lib/prisma.js";

const SLOT_SECS = 180; // 3 minutes
const slotKeyForUnix = (unix) => BigInt(Math.floor(unix / SLOT_SECS));

function logNow() {
  const nowQc = nowIn(QUEBEC_TZ);
  console.log(
    `Rescheduler @ ${nowQc.format("YYYY-MM-DD HH:mm:ss z")} | UTC ${moment
      .utc()
      .format()} | window ${START}:00–${END}:00`
  );
}

/**
 * Compute the next valid slot (unix seconds) in the lead's tz.
 * Starts from "now or next window start", aligns to 5-min, skips weekends,
 * and optionally adds a stagger (seconds) while staying inside today's window;
 * if overflow, moves to next business day START.
 */
function nextSlotUnixInTz(tz, staggerSeconds = 0) {
  const zone = pickTz(tz);
  // base: "now" (inside window -> +2min) or next window start
  let base = nextInsideWindowUnix(zone); // sync
  base = rollForwardToWindowUnix(base, zone); // safety (usually no-op)
  base = ceilToSlotUnix(base);

  // apply stagger and clamp to window
  let m = moment.unix(base + staggerSeconds).tz(zone);
  const endToday = m.clone().hour(END).minute(0).second(0).millisecond(0);

  if (m.isSameOrAfter(endToday)) {
    // move to next business day start at START:00
    m = endToday
      .clone()
      .add(1, "day")
      .hour(START)
      .minute(0)
      .second(0)
      .millisecond(0);
    while ([0, 6].includes(m.day())) m = m.add(1, "day");
  }
  // align again to 5-min
  const unix = ceilToSlotUnix(m.unix());
  return rollForwardToWindowUnix(unix, zone);
}

async function detectAndRescheduleAnomalies() {
  logNow();
  const utcNow = moment.utc().toDate();

  // 1) Attempts that are past due but still SCHEDULED
  const overdueAttempts = await prisma.callAttempt.findMany({
    where: {
      status: "SCHEDULED",
      scheduledAt: { lt: utcNow },
    },
    include: { lead: true },
    take: 500,
    orderBy: { scheduledAt: "asc" },
  });

  // 2) Failed/exhausted leads whose nextScheduledAt is in the past.
  // (If you intend to “reset” exhausted leads, keep this; otherwise remove.)
  const overdueFailedLeads = await prisma.lead.findMany({
    where: {
      nextScheduledAt: { lt: utcNow },
      status: "FAILED",
    },
    include: { callAttempts: true },
    take: 200,
    orderBy: { nextScheduledAt: "asc" },
  });

  // Merge into a unique attempt set (avoid duplicates)
  const targets = new Map();
  for (const a of overdueAttempts) targets.set(a.id, a);
  for (const l of overdueFailedLeads) {
    for (const a of l.callAttempts || []) targets.set(a.id, { ...a, lead: l });
  }
  const attempts = [...targets.values()].filter(Boolean);

  if (attempts.length === 0) {
    console.log("No overdue attempts or failed leads to process.");
    return;
  }

  // Sort by original schedule to keep relative order
  attempts.sort(
    (a, b) =>
      new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()
  );

  // Group by tz to compute nice stagger per zone
  const byTz = new Map();
  for (const attempt of attempts) {
    const lead =
      attempt.lead ||
      (await prisma.lead.findUnique({ where: { id: attempt.leadId } }));
    if (!lead) continue;
    const tz = pickTz(lead.timezone);
    const list = byTz.get(tz) || [];
    list.push({ attempt, lead });
    byTz.set(tz, list);
  }

  for (const [tz, list] of byTz.entries()) {
    // keep a simple sequential 5-min staggering within the tz group
    let index = 0;

    // oldest first
    list.sort(
      (a, b) =>
        new Date(a.attempt.scheduledAt).getTime() -
        new Date(b.attempt.scheduledAt).getTime()
    );

    for (const { attempt, lead } of list) {
      try {
        // If you want to “reset exhausted leads”, do it here:
        const exhausted =
          lead.status === "FAILED" && lead.attempts >= (lead.maxAttempts ?? 3);
        let targetUnix = nextSlotUnixInTz(tz, index * SLOT_SECS); // 5-min staggering
        index += 1;

        // Transaction: take a per-slot advisory lock so we don't collide with other reschedulers
        const scheduledAt = new Date(targetUnix * 1000);
        const slotKey = slotKeyForUnix(targetUnix);

        await prisma.$transaction(async (tx) => {
          const got =
            await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(${slotKey}) AS ok;`;
          if (!got?.[0]?.ok) {
            // slot busy → bump by one slot and try once more
            targetUnix += SLOT_SECS;
          }

          const finalAt = new Date(targetUnix * 1000);

          if (exhausted) {
            // Reset lead & create a fresh attempt #1
            await tx.lead.update({
              where: { id: lead.id },
              data: {
                status: "SCHEDULED",
                attempts: 1,
                nextScheduledAt: finalAt,
              },
            });
            await tx.callAttempt.create({
              data: {
                leadId: lead.id,
                attemptNumber: 1,
                status: "SCHEDULED",
                scheduledAt: finalAt,
              },
            });
          } else {
            // Keep the same attemptNumber; just move the time and re-queue the lead
            await tx.callAttempt.update({
              where: { id: attempt.id },
              data: { scheduledAt: finalAt },
            });
            await tx.lead.update({
              where: { id: lead.id },
              data: {
                status: "SCHEDULED",
                nextScheduledAt: finalAt,
              },
            });
          }
        });

        console.log(
          `Rescheduled lead ${lead.id} → ${moment(targetUnix * 1000)
            .tz(tz)
            .format("YYYY-MM-DD HH:mm:ss z")} (tz=${tz})`
        );
      } catch (err) {
        console.error(`Failed to reschedule lead ${lead.id}: ${err.message}`);
      }
    }
  }
}

// Québec time cron (every 5 minutes)
cron.schedule(
  "*/5 * * * *",
  () => {
    detectAndRescheduleAnomalies().catch((e) =>
      console.error(`Rescheduler run error: ${e.message}`)
    );
  },
  { timezone: QUEBEC_TZ }
);

// Run once on boot
detectAndRescheduleAnomalies().catch((e) =>
  console.error(`Initial rescheduler error: ${e.message}`)
);
