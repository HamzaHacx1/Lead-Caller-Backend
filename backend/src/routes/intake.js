import { PrismaClient } from "@prisma/client";
import moment from "moment-timezone";
import { Router } from "express";

import { getQuebecNowAsync, QUEBEC_TZ } from "../lib/quebecTime.js";
import { nextInsideWindowUnix, pickTz } from "../lib/schedule.js";
import { callOutbound } from "../lib/elevenlabs.js";

// import { assertApiKey } from "../lib/auth.js";

const prisma = new PrismaClient();
const r = Router();

// Local constant (9→16 window length). Keep in sync with schedule.js if you change hours.
const WINDOW_LEN_SECS = 7 * 3600;

/**
 * Zapier/FB Lead Ads intake
 * Auth: API key (Authorization: Bearer <API_KEY>) if you enable assertApiKey
 * Supports:
 *  - forceNow: true       -> schedule ~now (5s)
 *  - ignoreWindow: true   -> bypass 9-4 window clamp
 *  - voicemail flags: variables|metadata.{voicemailDetected|hangup_on_voicemail} -> skip immediate call
 */
r.post("/facebook", async (req, res) => {
  try {
    // Optional: assertApiKey(req);

    const {
      fbLeadId,
      full_name,
      phone,
      email,
      timezone,
      variables = {},
      metadata = {},
      forceNow = false,
      ignoreWindow = false,
    } = req.body || {};

    // Basic input sanity (prevents Prisma "Argument `phone` is missing.")
    if (!full_name || !phone) {
      return res
        .status(400)
        .json({ ok: false, error: "missing_name_or_phone" });
    }

    const qnow = await getQuebecNowAsync(); // { unixNow, label, tz, ... }
    const nowUnix = qnow.unixNow; // epoch seconds UTC

    console.log("[INTAKE] body:", {
      fbLeadId,
      full_name,
      phone,
      timezone,
      forceNow,
      ignoreWindow,
      quebecNow: qnow.label,
    });

    // Dedupe on fbLeadId
    if (fbLeadId) {
      const exists = await prisma.lead.findUnique({ where: { fbLeadId } });
      if (exists) {
        console.log("[INTAKE] deduped -> leadId", exists.id);
        return res.json({ ok: true, deduped: true, leadId: exists.id });
      }
    }

    // Choose a timezone (default to Quebec if nothing valid provided)
    const tz = pickTz(timezone) || process.env.DEFAULT_TZ || QUEBEC_TZ;

    // --- Compute schedule (MUST await) ---
    const startUnix = await nextInsideWindowUnix(tz);
    let scheduledUnix = forceNow
      ? Math.floor(Date.now() / 1000) + 5
      : await nextInsideWindowUnix(tz);

    if (!ignoreWindow) {
      const endUnix = startUnix + WINDOW_LEN_SECS;
      if (!(nowUnix >= startUnix && nowUnix <= endUnix)) {
        scheduledUnix = startUnix;
      }
    }

    if (!Number.isFinite(scheduledUnix)) {
      throw new Error(`scheduledUnix not finite: ${scheduledUnix}`);
    }
    const scheduledAt = new Date(scheduledUnix * 1000);
    if (Number.isNaN(scheduledAt.getTime())) {
      throw new Error(`Invalid Date from scheduledUnix: ${scheduledUnix}`);
    }

    // --- Create lead snapshot ---
    const lead = await prisma.lead.create({
      data: {
        fbLeadId: fbLeadId || null,
        fullName: full_name,
        phone,
        email: email || null,
        timezone: tz,
        status: "SCHEDULED",
        metadata,
      },
    });

    // --- First attempt record (ensures row exists for the view/worker) ---
    const attemptNumber = 1;
    await prisma.callAttempt.create({
      data: {
        leadId: lead.id,
        attemptNumber,
        status: "SCHEDULED",
        scheduledAt, // UTC instant (Date)
      },
    });

    // ---- Decide whether to call immediately ----
    const vmFlag =
      Boolean(variables?.voicemailDetected) ||
      Boolean(metadata?.voicemailDetected) ||
      Boolean(variables?.hangup_on_voicemail) ||
      Boolean(metadata?.hangup_on_voicemail);

    // Robust "inside window now" check using epoch + TZ
    const nowLocal = moment.unix(nowUnix).tz(tz);
    const startLocal = nowLocal
      .clone()
      .hour(9)
      .minute(0)
      .second(0)
      .millisecond(0);
    const endLocal = nowLocal
      .clone()
      .hour(16)
      .minute(0)
      .second(0)
      .millisecond(0);
    const isInsideWindowNow =
      nowLocal.isSameOrAfter(startLocal) && nowLocal.isSameOrBefore(endLocal);

    // Run now if: not voicemail AND (ignoreWindow || inside window)
    const shouldCallNow = !vmFlag && (ignoreWindow || isInsideWindowNow);

    if (shouldCallNow) {
      try {
        await callOutbound({
          to: phone,
          lead: { ...lead, scheduledUnix },
          attemptNumber,
          variables,
        });
        console.log("[INTAKE] immediate call triggered:", {
          leadId: lead.id,
          scheduledUnix,
          reason: ignoreWindow ? "ignoreWindow" : "insideWindowNow",
        });
      } catch (err) {
        console.error("[INTAKE] callOutbound failed:", err?.message || err);
      }
    } else {
      console.log("[INTAKE] immediate call skipped:", {
        leadId: lead.id,
        reason: vmFlag ? "voicemailDetected" : "outsideWindow",
        scheduledUnix,
      });
    }

    return res.json({
      ok: true,
      leadId: lead.id,
      scheduled_time_unix: scheduledUnix,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "intake_failed" });
  }
});

export default r;
