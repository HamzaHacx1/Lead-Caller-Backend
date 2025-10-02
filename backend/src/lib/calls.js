// lib/calls.js
import moment from "moment-timezone";
import prisma from "./prisma.js";
import {
  START,
  END,
  pickTz,
  SLOT_SECS,
  ceilToSlotUnix,
  rollForwardToWindowUnix,
} from "./schedule.js";
import { QUEBEC_TZ } from "./quebecTime.js";
import { getCallQueue } from "./redisQueue.js";

const RESCUE_REASON_DEFAULT = "auto_reschedule";

const PRECALL_NUDGE_MS = Math.max(
  0,
  Number(process.env.PRECALL_CALL_DELAY_MS ?? 5 * 60 * 1000)
);

function slotKeyForUnix(unix) {
  return BigInt(Math.floor(unix / SLOT_SECS));
}

/**
 * Compute the next business-day call time for a lead, aligned to SLOT_SECS.
 * - If baseUnix is provided, use it; otherwise next weekday @ START.
 * - Skips weekends and clamps to [START, END - PRECALL_NUDGE_MS].
 */
export function computeNextBusinessCallUnix(tz = QUEBEC_TZ, baseUnix = null) {
  const zone = pickTz(tz);
  const base = baseUnix ? moment.unix(baseUnix).tz(zone) : moment().tz(zone);
  const hours = Math.max(1, Number(process.env.CALL_NEXT_DELAY_HOURS ?? 24));

  // 1) Start from "now + hours"
  const target = base.clone().add(hours, "hours");
  // 2) Align to slot boundary
  const unix = ceilToSlotUnix(target.unix());
  // 3) Clamp into business window and skip weekends
  const clampedUnix = rollForwardToWindowUnix(unix, zone);
  return clampedUnix;
}

/**
 * Reserve a call slot atomically and create a callAttempt, updating the lead.
 * Returns { attempt, scheduledUnix }.
 */
export async function reserveCallSlotAndCreateAttempt({ leadId, attemptNumber, tz }) {
  const zone = pickTz(tz || QUEBEC_TZ);
  let scheduledUnix = computeNextBusinessCallUnix(zone, null);

  const result = await prisma.$transaction(async (tx) => {
    let tries = 0;
    while (tries < 300) {
      // Ensure within window bounds
      let m = moment.unix(scheduledUnix).tz(zone);
      const endToday = m.clone().hour(END).minute(0).second(0).millisecond(0);
      if (m.isSameOrAfter(endToday)) {
        m = endToday.add(1, "day").hour(START).minute(0).second(0).millisecond(0);
        while (m.day() === 0 || m.day() === 6) m = m.add(1, "day");
        scheduledUnix = ceilToSlotUnix(m.unix());
      }

      const key = slotKeyForUnix(scheduledUnix);
      const lockRow = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(${key}) AS ok;`;
      if (!lockRow?.[0]?.ok) {
        scheduledUnix += SLOT_SECS; tries += 1; continue;
      }

      const begin = new Date(scheduledUnix * 1000);
      const end = new Date((scheduledUnix + SLOT_SECS - 1) * 1000);
      const clash = await tx.callAttempt.findFirst({
        where: { status: "SCHEDULED", scheduledAt: { gte: begin, lte: end } },
        select: { id: true },
      });
      if (clash) { scheduledUnix += SLOT_SECS; tries += 1; continue; }

      const attempt = await tx.callAttempt.create({
        data: {
          leadId,
          attemptNumber,
          status: "SCHEDULED",
          scheduledAt: new Date(scheduledUnix * 1000),
        },
      });
      await tx.lead.update({
        where: { id: leadId },
        data: {
          status: "SCHEDULED",
          nextScheduledAt: new Date(scheduledUnix * 1000),
          attempts: attemptNumber,
        },
      });
      return { attempt, scheduledUnix };
    }
    throw new Error("no_free_slot_for_retry");
  });
  return result;
}

/**
 * Move an existing scheduled attempt to a new slot while keeping the attempt number.
 * Returns { attempt, scheduledUnix } or null if the attempt/lead can no longer be moved.
 */
export async function rescheduleScheduledAttempt({
  leadId,
  attemptId,
  tz,
  earliestUnix,
  rescheduleReason = RESCUE_REASON_DEFAULT,
}) {
  const zone = pickTz(tz || QUEBEC_TZ);
  const baseUnix = ceilToSlotUnix(
    Number.isFinite(earliestUnix) ? earliestUnix : moment().tz(zone).add(10, "minutes").unix()
  );

  const result = await prisma.$transaction(async (tx) => {
    const attempt = await tx.callAttempt.findUnique({ where: { id: attemptId } });
    if (!attempt || attempt.status !== "SCHEDULED" || attempt.leadId !== leadId) {
      return null;
    }

    const lead = await tx.lead.findUnique({ where: { id: leadId } });
    if (!lead || lead.status !== "SCHEDULED") {
      return null;
    }

    let scheduledUnix = baseUnix;
    let tries = 0;
    while (tries < 300) {
      scheduledUnix = rollForwardToWindowUnix(scheduledUnix, zone);

      const key = slotKeyForUnix(scheduledUnix);
      const lockRow = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(${key}) AS ok;`;
      if (!lockRow?.[0]?.ok) {
        scheduledUnix += SLOT_SECS;
        tries += 1;
        continue;
      }

      const begin = new Date(scheduledUnix * 1000);
      const end = new Date((scheduledUnix + SLOT_SECS - 1) * 1000);
      const clash = await tx.callAttempt.findFirst({
        where: {
          status: "SCHEDULED",
          scheduledAt: { gte: begin, lte: end },
          NOT: { id: attemptId },
        },
        select: { id: true },
      });
      if (clash) {
        scheduledUnix += SLOT_SECS;
        tries += 1;
        continue;
      }

      const payloadObj =
        attempt.payload && typeof attempt.payload === "object" && !Array.isArray(attempt.payload)
          ? { ...attempt.payload }
          : {};

      payloadObj.last_reschedule = {
        reason: rescheduleReason,
        from: attempt.scheduledAt ? new Date(attempt.scheduledAt).toISOString() : null,
        at: new Date().toISOString(),
      };

      const updatedAttempt = await tx.callAttempt.update({
        where: { id: attempt.id },
        data: {
          scheduledAt: new Date(scheduledUnix * 1000),
          payload: payloadObj,
        },
      });

      await tx.lead.update({
        where: { id: leadId },
        data: {
          nextScheduledAt: new Date(scheduledUnix * 1000),
          status: "SCHEDULED",
          lastProcessedAt: new Date(),
        },
      });

      return { attempt: updatedAttempt, scheduledUnix };
    }

    throw new Error("no_free_slot_for_reschedule");
  });

  return result;
}

/** Enqueue the call job to fire pre-nudge then call at the planned time. */
export async function enqueueCallForAttempt({ leadId, attemptId, attemptNumber, scheduledUnix }) {
  const queue = getCallQueue();
  const callAtUnix = scheduledUnix; // actual call time
  const runAtMs = callAtUnix * 1000 - PRECALL_NUDGE_MS; // execute job PRECALL before call
  const delay = Math.max(0, runAtMs - Date.now());

  const jobId = `lead:${leadId}:attempt:${attemptNumber}`;
  try {
    const existing = await queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState().catch(() => null);
      if (["delayed", "waiting", "failed"].includes(state)) {
        await existing.remove().catch(() => {});
      }
    }
  } catch (e) {
    // Best effort; if redis unavailable we still try to enqueue below
  }

  await queue.add(
    "place-call",
    { leadId, attemptId, attemptNumber, callAtUnix },
    { delay, jobId }
  );
}
