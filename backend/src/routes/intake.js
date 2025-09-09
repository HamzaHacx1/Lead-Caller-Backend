import sanitizeHtml from "sanitize-html";
import moment from "moment-timezone";
import { Router } from "express";

import {
  START,
  END,
  rollForwardToWindowUnix,
  nextInsideWindowUnix,
  ceilToSlotUnix,
  pickTz,
} from "../lib/schedule.js";
import { nowIn, QUEBEC_TZ } from "../lib/quebecTime.js";
// routes/intake.js
import prisma from "../lib/prisma.js";
import { enqueueCallForAttempt } from "../lib/calls.js";

// -----------------------------------------------------------------------------
// Constants & tiny helpers
// -----------------------------------------------------------------------------
const SLOT_SECS = 180; // 3 minutes per call slot

/** Map a unix second to a BIGINT advisory lock key (one per 5-min slot). */
function slotKeyForUnix(unix) {
  return BigInt(Math.floor(unix / SLOT_SECS));
}

/** Basic field sanitizers / validators */
function cleanName(v) {
  return sanitizeHtml(v ?? "", {
    allowedTags: [],
    allowedAttributes: {},
  }).trim();
}
function cleanPhone(v) {
  const s = sanitizeHtml(v ?? "", {
    allowedTags: [],
    allowedAttributes: {},
  }).replace(/[^\d+]/g, "");
  return s.trim();
}
function cleanEmail(v) {
  if (!v) return null;
  const s = sanitizeHtml(v, { allowedTags: [], allowedAttributes: {} }).trim();
  return s || null;
}
function isValidEmail(v) {
  if (!v) return true; // allow empty
  return /\S+@\S+\.\S+/.test(v);
}
function isValidPhone(v) {
  if (!v) return false;
  return String(v).replace(/\D/g, "").length >= 10;
}

// -----------------------------------------------------------------------------
// Setup
// -----------------------------------------------------------------------------
const r = Router();

// -----------------------------------------------------------------------------
// POST /intake/facebook
// Creates a Lead and reserves the first call attempt in a 5-min slot
// - Respects business window [START, END) & skips weekends
// - Prevents overlapping calls system-wide via tx-level advisory locks
// -----------------------------------------------------------------------------
r.post("/facebook", async (req, res) => {
  try {
    // -------- 1) Parse & validate input --------
    const {
      fbLeadId,
      full_name,
      phone,
      email,
      timezone,
      variables = {}, // kept for compatibility (not used here)
      metadata = {},
      forceNow = false, // if true, prefer "now + 2m" before clamping to window
      ignoreWindow = false, // if true, prefer "now" before clamping (we still clamp)
    } = req.body ?? {};

    if (!full_name || !phone) {
      return res
        .status(400)
        .json({ ok: false, error: "missing_name_or_phone" });
    }

    const sanitizedName = cleanName(full_name);
    const sanitizedPhone = cleanPhone(phone);
    const sanitizedEmail = cleanEmail(email);

    if (!isValidPhone(sanitizedPhone) || !isValidEmail(sanitizedEmail)) {
      return res
        .status(400)
        .json({ ok: false, error: "invalid_phone_or_email" });
    }

    // -------- 2) Fast dedup by fbLeadId (if provided) --------
    if (fbLeadId) {
      const exists = await prisma.lead.findUnique({ where: { fbLeadId } });
      if (exists) {
        console.log("[INTAKE] deduped -> leadId", exists.id);
        return res.json({ ok: true, deduped: true, leadId: exists.id });
      }
    }

    // -------- 3) Compute target time & clamp to window --------
    const tzForLead = pickTz(timezone) || process.env.DEFAULT_TZ || QUEBEC_TZ;
    const nowLocal = nowIn(tzForLead);
    const isWeekday = nowLocal.day() !== 0 && nowLocal.day() !== 6;
    const insideWindowNow =
      isWeekday && nowLocal.hour() >= START && nowLocal.hour() < END;

    // Choose a base unix time:
    //  - forceNow/ignoreWindow → now (+2m for forceNow)
    //  - else: 2m from now if inside window, otherwise next window start
    let targetUnix;
    if (ignoreWindow || forceNow) {
      targetUnix = (
        ignoreWindow ? nowLocal : nowLocal.clone().add(2, "minutes")
      ).unix();
    } else {
      targetUnix = insideWindowNow
        ? nowLocal.clone().add(2, "minutes").unix()
        : nextInsideWindowUnix(tzForLead);
    }

    // Always clamp into the valid business window and align to next 5-min slot
    targetUnix = rollForwardToWindowUnix(targetUnix, tzForLead);
    let candidateUnix = ceilToSlotUnix(targetUnix);

    // -------- 4) Atomically create Lead and reserve a free 5-min slot --------
    const result = await prisma.$transaction(async (tx) => {
      // 4a) Create the lead
      const lead = await tx.lead.create({
        data: {
          fbLeadId: fbLeadId || null,
          fullName: sanitizedName,
          phone: sanitizedPhone,
          email: sanitizedEmail,
          timezone: tzForLead,
          status: "SCHEDULED",
          metadata,
        },
      });

      // 4b) Try to reserve a slot by moving in 5-min steps if needed
      let scheduledUnix = candidateUnix;
      let tries = 0;

      while (tries < 300) {
        // up to 25 hours worth of slots; should resolve quickly
        // If past today's window end, jump to next business day @ START
        const m = moment.unix(scheduledUnix).tz(tzForLead);
        const start = m.clone().hour(START).minute(0).second(0).millisecond(0);
        const end = m.clone().hour(END).minute(0).second(0).millisecond(0);
        if (m.isSameOrAfter(end)) {
          let n = end
            .clone()
            .add(1, "day")
            .hour(START)
            .minute(0)
            .second(0)
            .millisecond(0);
          while (n.day() === 0 || n.day() === 6) n = n.add(1, "day");
          scheduledUnix = ceilToSlotUnix(n.unix());
        }

        // Take a transaction-scoped advisory lock for this slot
        const key = slotKeyForUnix(scheduledUnix);
        const lockRow = await tx.$queryRaw`
          SELECT pg_try_advisory_xact_lock(${key}) AS ok;
        `;
        const gotLock = Boolean(lockRow?.[0]?.ok);

        if (gotLock) {
          // Ensure no SCHEDULED attempt already sits in this 5-min bin
          const begin = new Date(scheduledUnix * 1000);
          const endSlot = new Date((scheduledUnix + SLOT_SECS - 1) * 1000);

          const clash = await tx.callAttempt.findFirst({
            where: {
              status: "SCHEDULED",
              scheduledAt: { gte: begin, lte: endSlot },
            },
            select: { id: true },
          });

          if (!clash) {
            const attempt = await tx.callAttempt.create({
              data: {
                leadId: lead.id,
                attemptNumber: 1,
                status: "SCHEDULED",
                scheduledAt: new Date(scheduledUnix * 1000),
              },
            });

            await tx.lead.update({
              where: { id: lead.id },
              data: {
                attempts: 1,
                lastAttemptAt: new Date(scheduledUnix * 1000),
                nextScheduledAt: new Date(scheduledUnix * 1000),
              },
            });

            return { lead, attempt, scheduledUnix };
          }
          // Slot was locked but a clash exists (very rare) → try next slot
        }

        scheduledUnix += SLOT_SECS;
        tries += 1;
      }

      throw new Error("no_free_slot_found");
    });

    // -------- 5) Enqueue call job (pre-nudge + call) --------
    try {
      await enqueueCallForAttempt({
        leadId: result.lead.id,
        attemptId: result.attempt.id,
        attemptNumber: 1,
        scheduledUnix: result.scheduledUnix,
      });
    } catch (e) {
      console.warn("[INTAKE] failed to enqueue call job", e?.message);
    }

    // -------- 6) Respond --------
    return res.json({
      ok: true,
      leadId: result.lead.id,
      attemptId: result.attempt.id,
      scheduled_time_unix: result.scheduledUnix,
      scheduled_time_local: moment
        .unix(result.scheduledUnix)
        .tz(tzForLead)
        .format("YYYY-MM-DD HH:mm:ss z"),
      window_tz: tzForLead,
      window_hours: { start: START, end: END },
      call_now: insideWindowNow && (forceNow || ignoreWindow),
    });
  } catch (e) {
    console.error("[INTAKE error]", e);
    return res.status(500).json({ ok: false, error: "intake_failed" });
  }
});

export default r;
