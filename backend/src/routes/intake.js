import { PrismaClient } from "@prisma/client";
import { Router } from "express";

import { getQuebecNowAsync, QUEBEC_TZ } from "../lib/quebecTime.js";
import { nextInsideWindowUnix, pickTz } from "../lib/schedule.js";
import { callOutbound } from "../lib/elevenlabs.js";
import { assertApiKey } from "../lib/auth.js";

const prisma = new PrismaClient();
const r = Router();

/**
 * Zapier/FB Lead Ads intake
 * Auth: API key (Authorization: Bearer <API_KEY>)
 * Supports:
 *  - forceNow: true       -> schedule ~now (5s)
 *  - ignoreWindow: true   -> bypass 9-4 window clamp
 *  - voicemail flags: variables|metadata.{voicemailDetected|hangup_on_voicemail} -> skip immediate call
 */
r.post("/facebook", async (req, res) => {
  try {
    // Optional: assert API key if you require it here
    // assertApiKey(req);

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

    const qnow = await getQuebecNowAsync(); // realtime from API (with safe fallback)
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

    // Compute a schedule time that respects the window unless ignoreWindow
    const WINDOW_LEN_SECS = 7 * 3600; // 9am -> 4pm
    const nowUnix = qnow.unixNow; // UTC seconds (same everywhere)
    let scheduledUnix;

    if (forceNow) {
      scheduledUnix = Math.floor(Date.now() / 1000) + 5;
      if (!ignoreWindow) {
        // Clamp to inside window if "now" is outside
        const startUnix = nextInsideWindowUnix(tz);
        const endUnix = startUnix + WINDOW_LEN_SECS;
        if (!(nowUnix >= startUnix && nowUnix <= endUnix)) {
          scheduledUnix = startUnix;
        }
      }
    } else {
      scheduledUnix = nextInsideWindowUnix(tz);
    }

    // Create lead
    const lead = await prisma.lead.create({
      data: {
        fbLeadId: fbLeadId || null,
        fullName: full_name,
        phone,
        email,
        timezone: tz,
        status: "SCHEDULED",
        metadata,
      },
    });

    // First attempt record
    const attemptNumber = 1;
    await prisma.callAttempt.create({
      data: {
        leadId: lead.id,
        attemptNumber,
        status: "SCHEDULED",
        scheduledAt: new Date(scheduledUnix * 1000),
      },
    });

    // ---- Determine if we should call immediately ----
    // Voicemail detection flags that should skip any immediate run
    const vmFlag =
      Boolean(variables?.voicemailDetected) ||
      Boolean(metadata?.voicemailDetected) ||
      Boolean(variables?.hangup_on_voicemail) ||
      Boolean(metadata?.hangup_on_voicemail);

    // Are we currently inside the window (for this tz)?
    // nextInsideWindowUnix(tz) gives the next valid slot; we check both today and yesterday windows.
    const windowStart = nextInsideWindowUnix(tz);
    const insideToday =
      nowUnix >= windowStart && nowUnix <= windowStart + WINDOW_LEN_SECS;
    const insideYesterday =
      nowUnix >= windowStart - 24 * 3600 &&
      nowUnix <= windowStart - 24 * 3600 + WINDOW_LEN_SECS;
    const isInsideWindowNow = insideToday || insideYesterday;

    // Conditions to run immediately:
    //  - not flagged for voicemail
    //  - AND (ignoreWindow || (forceNow && ignoreWindow) || (forceNow && isInsideWindowNow) || (!forceNow && isInsideWindowNow))
    //    i.e., if ignoreWindow true -> always run now (unless vmFlag)
    //          else only run now when actually inside the window
    const shouldCallNow = !vmFlag && (ignoreWindow || isInsideWindowNow);

    if (shouldCallNow) {
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
    } else {
      console.log("[INTAKE] immediate call skipped:", {
        leadId: lead.id,
        reason: vmFlag ? "voicemailDetected" : "outsideWindow",
        scheduledUnix,
      });
    }

    res.json({ ok: true, leadId: lead.id, scheduled_time_unix: scheduledUnix });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "intake_failed" });
  }
});

export default r;
