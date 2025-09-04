import { PrismaClient } from "@prisma/client";
// jobs/dispatcher.js
import moment from "moment-timezone";

import { START, END, pickTz } from "../lib/schedule.js";
import { callOutbound } from "../lib/elevenlabs.js";
import { QUEBEC_TZ } from "../lib/quebecTime.js";

const prisma = new PrismaClient();

/** Optional: compress time in staging (e.g., TIME_SCALE=60 means 1s = 1m) */
const TIME_SCALE = Number(process.env.TIME_SCALE ?? "1");
const TICK_MS = Math.max(
  1000,
  Number(process.env.DISPATCHER_TICK_MS ?? "30000")
); // default: 30s

function scaleDelay(ms) {
  return Math.max(0, Math.floor(ms / TIME_SCALE));
}

function insideWindow(date, tz) {
  const m = moment(date).tz(pickTz(tz));
  const dow = m.day(); // 0 Sun..6 Sat
  const h = m.hour();
  return dow !== 0 && dow !== 6 && h >= START && h < END;
}

/**
 * Try to claim one lead for calling.
 * Uses pg_try_advisory_lock on lead.id (BIGINT) to prevent races across instances.
 */
async function claimOneDueLead(limitWindowCheck = true) {
  // pick a small batch to reduce contention
  const candidates = await prisma.lead.findMany({
    where: {
      status: "SCHEDULED",
      nextScheduledAt: { lte: new Date() },
      attempts: { gt: 0 }, // must have at least attempt #1 reserved by intake
    },
    orderBy: { nextScheduledAt: "asc" },
    take: 25,
  });

  for (const lead of candidates) {
    // hard guard against dialing outside window
    if (
      limitWindowCheck &&
      !insideWindow(new Date(), lead.timezone || QUEBEC_TZ)
    ) {
      continue;
    }

    // advisory lock per lead.id (transaction-scoped)
    const got = await prisma.$queryRaw`
      SELECT pg_try_advisory_lock(${BigInt(lead.id)}) AS ok;
    `;
    const ok = Boolean(got?.[0]?.ok);
    if (!ok) continue;

    try {
      // Re-read lead inside a transaction to confirm state
      const claimed = await prisma.$transaction(async (tx) => {
        const fresh = await tx.lead.findUnique({ where: { id: lead.id } });
        if (
          !fresh ||
          fresh.status !== "SCHEDULED" ||
          fresh.nextScheduledAt > new Date()
        ) {
          return null; // stale
        }

        // Move to IN_PROGRESS to block overlaps for this lead
        await tx.lead.update({
          where: { id: lead.id },
          data: { status: "IN_PROGRESS", lastProcessedAt: new Date() },
        });

        // Fetch the scheduled attempt we’re about to execute (highest attemptNumber with SCHEDULED at/<= now)
        const attempt = await tx.callAttempt.findFirst({
          where: {
            leadId: lead.id,
            status: "SCHEDULED",
            scheduledAt: { lte: new Date() },
          },
          orderBy: [{ attemptNumber: "desc" }, { scheduledAt: "asc" }],
        });

        return { fresh, attempt };
      });

      if (!claimed) {
        // nothing to do; unlock & continue
        await prisma.$queryRaw`SELECT pg_advisory_unlock(${BigInt(lead.id)});`;
        continue;
      }

      const { fresh: lockedLead, attempt } = claimed;

      // No scheduled attempt found (rare if someone edited DB) → push back to SCHEDULED next window and release
      if (!attempt) {
        const tz = lockedLead.timezone || QUEBEC_TZ;
        const m = moment().tz(tz);
        // next safe minute inside window
        let next = m
          .clone()
          .minute(Math.ceil((m.minute() + 1) / 5) * 5)
          .second(0);
        if (!insideWindow(next, tz)) {
          // roll to next day 09:00 (skip weekend)
          next = m
            .clone()
            .add(1, "day")
            .hour(START)
            .minute(0)
            .second(0)
            .millisecond(0);
          while ([0, 6].includes(next.day())) next = next.add(1, "day");
        }
        await prisma.lead.update({
          where: { id: lockedLead.id },
          data: { status: "SCHEDULED", nextScheduledAt: next.toDate() },
        });
        await prisma.$queryRaw`SELECT pg_advisory_unlock(${BigInt(lead.id)});`;
        continue;
      }

      // Place the call (idempotent on your side; webhook will finalize)
      await callOutbound({
        to: lockedLead.phone,
        lead: {
          id: lockedLead.id,
          fullName: lockedLead.fullName,
          email: lockedLead.email,
          timezone: lockedLead.timezone,
          scheduledAt: attempt.scheduledAt,
        },
        attemptNumber: attempt.attemptNumber,
        variables: {}, // add any dynamic vars here
        metadata: { source: "dispatcher", callAttemptId: attempt.id },
      });

      // We keep lead as IN_PROGRESS; webhook will:
      //  - set outcome
      //  - increment attempts
      //  - schedule next attempt if needed
      // Finally, release lock
      await prisma.$queryRaw`SELECT pg_advisory_unlock(${BigInt(lead.id)});`;

      // Claimed and triggered exactly one lead this loop
      return true;
    } catch (err) {
      console.error("[DISPATCHER] error while claiming lead", lead.id, err);
      // try to unlock in case of error
      await prisma.$queryRaw`SELECT pg_advisory_unlock(${BigInt(lead.id)});`;
    }
  }

  return false;
}

export async function runDispatcherOnce() {
  // Try to claim and fire as many as fit this tick
  let madeProgress = false;
  // small loop to drain a few per tick
  for (let i = 0; i < 10; i++) {
    const ok = await claimOneDueLead(true);
    if (!ok) break;
    madeProgress = true;
    // tiny delay to avoid hammering
    await new Promise((r) => setTimeout(r, scaleDelay(150)));
  }
  return madeProgress;
}

export function startDispatcher() {
  console.log(
    `[DISPATCHER] start: tick=${TICK_MS}ms, TIME_SCALE=${TIME_SCALE}, window=${START}:00–${END}:00`
  );
  const timer = setInterval(async () => {
    try {
      await runDispatcherOnce();
    } catch (e) {
      console.error("[DISPATCHER] tick error", e);
    }
  }, TICK_MS);

  return () => clearInterval(timer); // returns a stop() function
}
