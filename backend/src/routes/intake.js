import { PrismaClient } from "@prisma/client";
import moment from "moment-timezone";
import { Router } from "express";

import {
  START,
  END,
  WINDOW_LEN_SECS,
  nextInsideWindowUnixQuebec,
  pickTz,
} from "../lib/schedule.js";
import { renderTemplate } from "../helpers/renderTemplates.js";
import { getQuebecNow, QUEBEC_TZ } from "../lib/quebecTime.js";
import { sendEmail, sendSMS } from "../helpers/notify.js";
import { callOutbound } from "../lib/elevenlabs.js";

const prisma = new PrismaClient();
const r = Router();

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
    } = req.body || {};

    if (!full_name || !phone) {
      return res
        .status(400)
        .json({ ok: false, error: "missing_name_or_phone" });
    }

    const qnow = getQuebecNow(); // Synchronous, uses server time (America/Toronto)
    const nowUnix = qnow.unixNow;
    const nowLocal = moment.unix(nowUnix).tz(QUEBEC_TZ);

    // Deduplication
    if (fbLeadId) {
      const exists = await prisma.lead.findUnique({ where: { fbLeadId } });
      if (exists) {
        console.log("[INTAKE] deduped -> leadId", exists.id);
        return res.json({ ok: true, deduped: true, leadId: exists.id });
      }
    }

    // Use Québec time zone unless explicitly overridden and valid
    const tzForLead = pickTz(timezone) || process.env.DEFAULT_TZ || QUEBEC_TZ;

    // Determine scheduling time
    const startUnix = nextInsideWindowUnixQuebec();
    let scheduledUnix;

    if (forceNow || ignoreWindow) {
      // Schedule 2 minutes from now
      scheduledUnix = nowUnix + 120;
    } else {
      // Schedule within Québec window (9 AM to 7 PM EDT by default)
      const endUnix = startUnix + WINDOW_LEN_SECS;
      scheduledUnix =
        nowUnix >= startUnix && nowUnix <= endUnix ? nowUnix + 120 : startUnix;
    }

    const scheduledAt = new Date(scheduledUnix * 1000);

    // Save lead + call attempt in a single transaction
    const lead = await prisma.lead.create({
      data: {
        fbLeadId: fbLeadId || null,
        fullName: full_name,
        phone,
        email: email || null,
        timezone: tzForLead,
        status: "SCHEDULED",
        metadata,
        callAttempts: {
          create: {
            attemptNumber: 1,
            status: "SCHEDULED",
            scheduledAt,
          },
        },
      },
    });

    // Respond quickly
    res.json({
      ok: true,
      leadId: lead.id,
      scheduled_time_unix: scheduledUnix,
      scheduled_time_local: moment
        .unix(scheduledUnix)
        .tz(QUEBEC_TZ)
        .format("YYYY-MM-DD HH:mm:ss z"),
      window_tz: QUEBEC_TZ,
      window_hours: { start: START, end: END },
    });

    // Run heavy tasks in background
    (async () => {
      try {
        const tasks = [];

        if (email) {
          const html = renderTemplate("notify.html", {
            dashboard_link: "https://emploirapide.ca/documents",
          });
          tasks.push(
            sendEmail({
              to: email,
              subject: "Tu veux un job ? Il te reste une seule étape !",
              html,
              text: `Salut 👋\n\nTu viens de remplir notre formulaire 🙌\nBonne nouvelle : finalise ton inscription ici : ${process.env.DASHBOARD_URL}/complete-profile\n\nÀ bientôt !`,
            })
              .then(() => console.log(`[INTAKE] email sent to ${email}`))
              .catch((err) =>
                console.error("[INTAKE] sendEmail failed:", err.message)
              )
          );
        }

        tasks.push(
          sendSMS({
            to: phone,
            body: `T’as commencé ton inscription, mais ton profil est incomplet. On t’a renvoyé le courriel. Pense à vérifier les spams si jamais.`,
          })
            .then(() => console.log(`[INTAKE] SMS sent to ${phone}`))
            .catch((err) =>
              console.error("[INTAKE] sendSMS failed:", err.message)
            )
        );

        // Outbound call check
        const startLocal = nowLocal.clone().hour(START).minute(0).second(0);
        const endLocal = nowLocal.clone().hour(END).minute(0).second(0);
        const isInsideWindowNow =
          nowLocal.isSameOrAfter(startLocal) &&
          nowLocal.isSameOrBefore(endLocal);

        const vmFlag =
          Boolean(variables?.voicemailDetected) ||
          Boolean(metadata?.voicemailDetected) ||
          Boolean(variables?.hangup_on_voicemail) ||
          Boolean(metadata?.hangup_on_voicemail);

        if (!vmFlag && (ignoreWindow || forceNow || isInsideWindowNow)) {
          tasks.push(
            callOutbound({
              to: phone,
              lead: { ...lead, scheduledUnix },
              attemptNumber: 1,
              variables,
            })
              .then(() =>
                console.log("[INTAKE] immediate call triggered", {
                  leadId: lead.id,
                })
              )
              .catch((err) =>
                console.error("[INTAKE] callOutbound failed:", err.message)
              )
          );
        }

        await Promise.allSettled(tasks);
      } catch (err) {
        console.error("[INTAKE background error]", err);
      }
    })();
  } catch (e) {
    console.error("[INTAKE error]", e);
    return res.status(500).json({ ok: false, error: "intake_failed" });
  }
});

export default r;
