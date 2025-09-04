import { PrismaClient } from "@prisma/client";
import moment from "moment-timezone";
// src/tests/scheduled.js
import { Router } from "express";

import {
  START,
  END,
  pickTz,
  rollForwardToWindowUnix,
  ceilToSlotUnix,
} from "../lib/schedule.js";
import { processScheduledNotifications } from "../lib/notifications.js";
import { callOutbound } from "../lib/elevenlabs.js";
import { QUEBEC_TZ } from "../lib/quebecTime.js";

const prisma = new PrismaClient();
const r = Router();

const SLOT_SECS = 300; // 5 minutes
const slotKeyForUnix = (unix) => BigInt(Math.floor(unix / SLOT_SECS));

/** auth (very light) — set TEST_SECRET in env if you want to guard these */
// function requireTestSecret(req, res, next) {
//   const ok =
//     process.env.TEST_SECRET == null ||
//     req.headers.authorization === `Bearer ${process.env.TEST_SECRET}`;
//   if (!ok) return res.status(401).json({ ok: false, error: "unauthorized" });
//   next();
// }
// r.use(requireTestSecret);

/** ---- helpers ---- */
function nextSlotInTz(tz, offsetSecs = 0) {
  const now = moment().tz(tz);
  // base = now (rounded up) but clamp into window & skip weekends
  let base = now.clone();
  // if weekend → move to next weekday @ START
  while ([0, 6].includes(base.day())) base = base.add(1, "day");
  // if before window start → start today
  if (base.hour() < START)
    base = base.hour(START).minute(0).second(0).millisecond(0);
  // if after window end → next weekday @ START
  if (base.hour() >= END) {
    base = base.add(1, "day").hour(START).minute(0).second(0).millisecond(0);
    while ([0, 6].includes(base.day())) base = base.add(1, "day");
  }

  // align to 5-min slot
  const alignedUnix = ceilToSlotUnix(base.unix());
  let target = moment.unix(alignedUnix + offsetSecs).tz(tz);

  // clamp overflow to next business day @ START
  const endToday = target.clone().hour(END).minute(0).second(0).millisecond(0);
  if (target.isSameOrAfter(endToday)) {
    target = endToday
      .clone()
      .add(1, "day")
      .hour(START)
      .minute(0)
      .second(0)
      .millisecond(0);
    while ([0, 6].includes(target.day())) target = target.add(1, "day");
  }

  const unix = ceilToSlotUnix(target.unix());
  return rollForwardToWindowUnix(unix, tz);
}

/** ---- 1) Schedule a call for testing ----
 * Body:
 * {
 *   "full_name": "Alice Johnson",
 *   "phone": "+15145550123",
 *   "email": "alice@example.com",
 *   "timezone": "America/Toronto",
 *   "offsetSecs": 0,      // optional: +N seconds from the next slot
 *   "metadata": { "source": "test" }
 * }
 */
r.post("/schedule/call", async (req, res) => {
  try {
    const {
      full_name,
      phone,
      email = null,
      timezone = QUEBEC_TZ,
      offsetSecs = 0,
      metadata = {},
    } = req.body || {};

    if (!full_name || !phone)
      return res
        .status(400)
        .json({ ok: false, error: "missing_name_or_phone" });

    const tz = pickTz(timezone);
    let targetUnix = nextSlotInTz(tz, Number(offsetSecs) || 0);

    const result = await prisma.$transaction(async (tx) => {
      // create lead
      const lead = await tx.lead.create({
        data: {
          fullName: full_name,
          phone: String(phone).replace(/[^\d+]/g, ""),
          email: email,
          timezone: tz,
          status: "SCHEDULED",
          metadata: { ...metadata, test: true },
        },
      });

      // advisory lock per-slot
      const slotKey = slotKeyForUnix(targetUnix);
      const got =
        await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(${slotKey}) AS ok;`;

      if (!got?.[0]?.ok) {
        // slot busy → bump by one slot
        targetUnix += SLOT_SECS;
      }

      // ensure no clash
      const begin = new Date(targetUnix * 1000);
      const end = new Date((targetUnix + SLOT_SECS - 1) * 1000);
      const clash = await tx.callAttempt.findFirst({
        where: {
          status: "SCHEDULED",
          scheduledAt: { gte: begin, lte: end },
        },
        select: { id: true },
      });

      if (clash) {
        // bump one slot more
        targetUnix += SLOT_SECS;
      }

      const attempt = await tx.callAttempt.create({
        data: {
          leadId: lead.id,
          attemptNumber: 1,
          status: "SCHEDULED",
          scheduledAt: new Date(targetUnix * 1000),
        },
      });

      await tx.lead.update({
        where: { id: lead.id },
        data: {
          attempts: 1,
          lastAttemptAt: new Date(targetUnix * 1000),
          nextScheduledAt: new Date(targetUnix * 1000),
        },
      });

      return { lead, attempt, targetUnix };
    });

    return res.json({
      ok: true,
      leadId: result.lead.id,
      attemptId: result.attempt.id,
      scheduled_time_unix: result.targetUnix,
      scheduled_time_local: moment
        .unix(result.targetUnix)
        .tz(tz)
        .format("YYYY-MM-DD HH:mm:ss z"),
      tz,
    });
  } catch (e) {
    console.error("[/test/schedule/call] error", e);
    return res.status(500).json({ ok: false, error: e.message || "server" });
  }
});

/** ---- 2) Enqueue a notification for a lead (window-safe) ----
 * Body:
 * {
 *   "leadId": 123,
 *   "step": "ANSWERED_15M",  // or ANSWERED_30M / ANSWERED_24H / ANSWERED_48H
 *   "offsetSecs": 60         // optional, from the next valid instant
 * }
 */
r.post("/notifications/enqueue", async (req, res) => {
  try {
    const { leadId, step, offsetSecs = 0 } = req.body || {};
    if (!leadId || !step)
      return res.status(400).json({ ok: false, error: "missing_fields" });

    const lead = await prisma.lead.findUnique({
      where: { id: Number(leadId) },
    });
    if (!lead)
      return res.status(404).json({ ok: false, error: "lead_not_found" });

    const tz = pickTz(lead.timezone || QUEBEC_TZ);
    const baseUnix = nextSlotInTz(tz, 0);
    const scheduledUnix = ceilToSlotUnix(baseUnix + (Number(offsetSecs) || 0));

    const ev = await prisma.notificationEvent.create({
      data: {
        leadId: lead.id,
        step,
        scheduledAt: new Date(scheduledUnix * 1000),
        metadata: { attemptNumber: lead.attempts || 1, test: true },
      },
    });

    return res.json({
      ok: true,
      notificationId: ev.id,
      step,
      scheduled_time_unix: scheduledUnix,
      scheduled_time_local: moment
        .unix(scheduledUnix)
        .tz(tz)
        .format("YYYY-MM-DD HH:mm:ss z"),
      tz,
    });
  } catch (e) {
    console.error("[/test/notifications/enqueue] error", e);
    return res.status(500).json({ ok: false, error: e.message || "server" });
  }
});

/** ---- 3) Run notification worker once ---- */
r.post("/notifications/run", async (_req, res) => {
  try {
    await processScheduledNotifications(200);
    return res.json({ ok: true, ran: true });
  } catch (e) {
    console.error("[/test/notifications/run] error", e);
    return res.status(500).json({ ok: false, error: e.message || "server" });
  }
});

/** ---- 4) Inspect today’s slots (debug) ---- */
r.get("/slots/today", async (req, res) => {
  try {
    const { tz = QUEBEC_TZ } = req.query;
    const zone = pickTz(String(tz));
    const start = moment()
      .tz(zone)
      .hour(START)
      .minute(0)
      .second(0)
      .millisecond(0);
    const end = moment().tz(zone).hour(END).minute(0).second(0).millisecond(0);

    const rows = await prisma.callAttempt.findMany({
      where: {
        status: "SCHEDULED",
        scheduledAt: { gte: start.toDate(), lte: end.toDate() },
      },
      select: { id: true, leadId: true, scheduledAt: true },
      orderBy: { scheduledAt: "asc" },
      take: 500,
    });

    return res.json({
      ok: true,
      tz: zone,
      window: { start: START, end: END },
      count: rows.length,
      rows,
    });
  } catch (e) {
    console.error("[/test/slots/today] error", e);
    return res.status(500).json({ ok: false, error: e.message || "server" });
  }
});
// ⬇️ add near top imports

// ...

/**
 * POST /test/call-now
 * Create a lead and trigger an immediate outbound call (≈ +10s), bypassing window/weekend.
 * Body:
 * {
 *   "full_name": "Alice Johnson",
 *   "phone": "+15145550123",
 *   "email": "alice@example.com",
 *   "timezone": "America/Toronto",
 *   "variables": { "booking_url": "..." },   // optional
 *   "metadata":  { "source": "test" }        // optional
 * }
 */
r.post("/call-now", async (req, res) => {
  try {
    const {
      full_name,
      phone,
      email = null,
      timezone = QUEBEC_TZ,
      variables = {},
      metadata = {},
    } = req.body || {};

    if (!full_name || !phone) {
      return res
        .status(400)
        .json({ ok: false, error: "missing_name_or_phone" });
    }

    const tz = pickTz(timezone);

    // Schedule ≈ 10s from now, rounded to nearest 5-min boundary *without* window clamp.
    // This ensures the provider receives a schedule time that is effectively "now".
    const nowUnix = moment().tz(tz).unix();
    let scheduledUnix = nowUnix + 10; // small buffer
    scheduledUnix = ceilToSlotUnix(scheduledUnix); // keep 5-min alignment for consistency

    const result = await prisma.$transaction(async (tx) => {
      // create the lead
      const lead = await tx.lead.create({
        data: {
          fullName: full_name,
          phone: String(phone).replace(/[^\d+]/g, ""),
          email,
          timezone: tz,
          status: "SCHEDULED",
          metadata: { ...metadata, test: true, call_now: true },
        },
      });

      // attempt #1 immediately
      const attempt = await tx.callAttempt.create({
        data: {
          leadId: lead.id,
          attemptNumber: 1,
          status: "SCHEDULED",
          scheduledAt: new Date(scheduledUnix * 1000),
          payload: { reason: "call_now" },
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
    });

    // Fire the call right away (doesn't block DB tx)
    let convoId = null;
    try {
      const outbound = await callOutbound({
        to: String(phone).replace(/[^\d+]/g, ""),
        lead: {
          id: result.lead.id,
          email,
          timezone: tz,
          scheduledUnix: result.scheduledUnix, // provider uses this
        },
        attemptNumber: 1,
        variables,
        metadata: { source: "test_call_now" },
      });
      convoId = outbound.conversation_id || null;

      // record conversation id for convenience (best-effort)
      if (convoId) {
        await prisma.callAttempt.update({
          where: { id: result.attempt.id },
          data: { conversationId: convoId },
        });
      }
    } catch (e) {
      console.warn("[call-now] outbound error:", e?.message);
    }

    return res.json({
      ok: true,
      leadId: result.lead.id,
      attemptId: result.attempt.id,
      conversation_id: convoId,
      scheduled_time_unix: result.scheduledUnix,
      scheduled_time_local: moment
        .unix(result.scheduledUnix)
        .tz(tz)
        .format("YYYY-MM-DD HH:mm:ss z"),
      tz,
      note: "Immediate outbound triggered (window bypassed).",
    });
  } catch (e) {
    console.error("[/test/call-now] error", e);
    return res.status(500).json({ ok: false, error: e.message || "server" });
  }
});

export default r;
