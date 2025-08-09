import { PrismaClient } from "@prisma/client";
import { Router } from "express";

import { nextInsideWindowUnix, pickTz } from "../lib/schedule.js";
import { callOutbound } from "../lib/elevenlabs.js";
import { assertApiKey } from "../lib/auth.js";

const prisma = new PrismaClient();
const r = Router();

/**
 * Zapier/FB Lead Ads intake
 * Auth: API key (Authorization: Bearer <API_KEY>)
 * Supports:
 *  - forceNow: true  -> schedule ~now (5s)
 *  - ignoreWindow: true -> bypass 9-4 window clamp
 */
r.post("/facebook", async (req, res) => {
  try {
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
    } = req.body;

    console.log("[INTAKE] body:", {
      fbLeadId,
      full_name,
      phone,
      timezone,
      forceNow,
      ignoreWindow,
    });

    // Dedupe on fbLeadId
    if (fbLeadId) {
      const exists = await prisma.lead.findUnique({ where: { fbLeadId } });
      if (exists) {
        console.log("[INTAKE] deduped -> leadId", exists.id);
        return res.json({ ok: true, deduped: true, leadId: exists.id });
      }
    }

    const tz = pickTz(timezone);
    let scheduledUnix;

    if (forceNow) {
      scheduledUnix = Math.floor(Date.now() / 1000) + 5;
      if (!ignoreWindow) {
        // clamp to inside window if "now" is outside
        const windowUnix = nextInsideWindowUnix(tz);
        const endWindowUnix = windowUnix + 7 * 3600; // 9am -> 4pm window length
        const now = Math.floor(Date.now() / 1000);
        if (!(now >= windowUnix && now <= endWindowUnix)) {
          scheduledUnix = windowUnix;
        }
      }
    } else {
      scheduledUnix = nextInsideWindowUnix(tz);
    }

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

    const attemptNumber = 1;

    await prisma.callAttempt.create({
      data: {
        leadId: lead.id,
        attemptNumber,
        status: "SCHEDULED",
        scheduledAt: new Date(scheduledUnix * 1000),
      },
    });

    await callOutbound({
      to: phone,
      lead: { ...lead, scheduledUnix },
      attemptNumber,
      variables,
    });

    console.log("[INTAKE] scheduled:", { leadId: lead.id, scheduledUnix });
    res.json({ ok: true, leadId: lead.id, scheduled_time_unix: scheduledUnix });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "intake_failed" });
  }
});

export default r;
