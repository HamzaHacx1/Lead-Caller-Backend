import { PrismaClient } from "@prisma/client";
import moment from "moment-timezone";
import { Router } from "express";

import {
  START,
  END,
  WINDOW_LEN_SECS,
  nextInsideWindowUnixQuebec,
  pickTz, // still used for storing the lead's tz, but window is Quebec-anchored
} from "../lib/schedule.js";
import { getQuebecNowAsync, QUEBEC_TZ } from "../lib/quebecTime.js";
import { renderTemplate } from "../helpers/renderTemplates.js";
import { callOutbound } from "../lib/elevenlabs.js";

// import { assertApiKey } from "../lib/auth.js";

const prisma = new PrismaClient();
const r = Router();

/**
 * Zapier/FB Lead Ads intake
 * Window is anchored to Quebec (America/Toronto) using CALL_WINDOW_START/END.
 */
r.post("/facebook", async (req, res) => {
  try {
    // Optional: assertApiKey(req);

    const {
      fbLeadId,
      full_name,
      phone,
      email,
      timezone, // stored on lead; does NOT affect window
      variables = {},
      metadata = {},
      forceNow = false,
      ignoreWindow = false,
    } = req.body || {};

    // Basic input sanity
    if (!full_name || !phone) {
      return res
        .status(400)
        .json({ ok: false, error: "missing_name_or_phone" });
    }

    const qnow = await getQuebecNowAsync(); // { unixNow, label, ... }
    const nowUnix = qnow.unixNow; // epoch seconds UTC

    console.log("[INTAKE] body:", {
      fbLeadId,
      full_name,
      phone,
      timezone,
      forceNow,
      ignoreWindow,
      quebecNow: qnow.label,
      window: `${START}:00-${END}:00 Quebec`,
    });

    // Dedupe on fbLeadId
    if (fbLeadId) {
      const exists = await prisma.lead.findUnique({ where: { fbLeadId } });
      if (exists) {
        console.log("[INTAKE] deduped -> leadId", exists.id);
        return res.json({ ok: true, deduped: true, leadId: exists.id });
      }
    }

    // Keep the lead's own tz for display/notifications; window is Quebec-anchored
    const tzForLead = pickTz(timezone) || process.env.DEFAULT_TZ || QUEBEC_TZ;

    // --- Compute schedule in **Quebec** time (MUST await) ---
    const startUnix = await nextInsideWindowUnixQuebec();
    let scheduledUnix = forceNow
      ? Math.floor(Date.now() / 1000) + 5
      : await nextInsideWindowUnixQuebec();

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
        timezone: tzForLead,
        status: "SCHEDULED",
        metadata,
      },
    });
    if (email) {
      try {
        const html = renderTemplate("job-confirmation.html", {
          dashboard_link: "https://emploirapide.ca/documents",
        });

        await sendEmail({
          to: email,
          subject: "Tu veux un job ? Il te reste une seule étape !",
          html,
          text: `Salut 👋\n\nTu viens de remplir notre formulaire 🙌\nBonne nouvelle : finalise ton inscription ici : ${process.env.DASHBOARD_URL}/complete-profile\n\nÀ bientôt !`,
        });

        console.log(`[INTAKE] email sent to ${email}`);
      } catch (err) {
        console.error("[INTAKE] sendEmail failed:", err?.message || err);
      }
    }
    try {
      await sendSMS({
        to: phone,
        body: `T’as commencé ton inscription, mais ton profil est incomplet. On t’a renvoyé le courriel. Pense à vérifier les spams si jamais.`,
      });
      console.log(`[INTAKE] SMS sent to ${phone}`);
    } catch (err) {
      console.error("[INTAKE] sendSMS failed:", err?.message || err);
    }
    // --- First attempt record ---
    const attemptNumber = 1;
    await prisma.callAttempt.create({
      data: {
        leadId: lead.id,
        attemptNumber,
        status: "SCHEDULED",
        scheduledAt, // UTC instant
      },
    });

    // ---- Decide whether to call immediately (Quebec window) ----
    const vmFlag =
      Boolean(variables?.voicemailDetected) ||
      Boolean(metadata?.voicemailDetected) ||
      Boolean(variables?.hangup_on_voicemail) ||
      Boolean(metadata?.hangup_on_voicemail);

    const nowLocal = moment.unix(nowUnix).tz(QUEBEC_TZ);
    const startLocal = nowLocal
      .clone()
      .hour(START)
      .minute(0)
      .second(0)
      .millisecond(0);
    const endLocal = nowLocal
      .clone()
      .hour(END)
      .minute(0)
      .second(0)
      .millisecond(0);
    const isInsideWindowNow =
      nowLocal.isSameOrAfter(startLocal) && nowLocal.isSameOrBefore(endLocal);

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
          reason: ignoreWindow ? "ignoreWindow" : "insideQuebecWindowNow",
        });
      } catch (err) {
        console.error("[INTAKE] callOutbound failed:", err?.message || err);
      }
    } else {
      console.log("[INTAKE] immediate call skipped:", {
        leadId: lead.id,
        reason: vmFlag ? "voicemailDetected" : "outsideQuebecWindow",
        scheduledUnix,
      });
    }

    return res.json({
      ok: true,
      leadId: lead.id,
      scheduled_time_unix: scheduledUnix,
      window_tz: QUEBEC_TZ,
      window_hours: { start: START, end: END },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "intake_failed" });
  }
});

export default r;
