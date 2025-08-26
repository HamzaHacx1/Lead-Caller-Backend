import { PrismaClient } from "@prisma/client";
import moment from "moment-timezone";
import { Router } from "express";

import {
  START,
  END,
  WINDOW_LEN_SECS,
  nextInsideWindowUnixQuebec,
  pickTz,
  QUEBEC_TZ,
} from "../lib/schedule.js";
import { renderTemplate } from "../helpers/renderTemplates.js";
import { sendEmail, sendSMS } from "../helpers/notify.js";
import { getQuebecNow } from "../lib/quebecTime.js";
import { callOutbound } from "../lib/elevenlabs.js";

const prisma = new PrismaClient();
const r = Router();

/** Find next available slot with a 5-minute gap */
async function findNextSlot(startUnix, endUnix, tz) {
  const minGapSeconds = 300; // 5 minutes
  const scheduledAt = await prisma.callAttempt.findMany({
    where: {
      scheduledAt: {
        gte: new Date(startUnix * 1000),
        lte: new Date(endUnix * 1000),
      },
      status: "SCHEDULED",
    },
    select: { scheduledAt: true },
    orderBy: { scheduledAt: "asc" },
  });

  let nextSlot = startUnix;
  const scheduledTimes = scheduledAt.map((s) =>
    Math.floor(s.scheduledAt.getTime() / 1000)
  );

  for (const time of scheduledTimes) {
    if (time <= nextSlot && time + minGapSeconds > nextSlot) {
      nextSlot = time + minGapSeconds;
    }
  }

  // Ensure slot is within window
  if (nextSlot > endUnix) {
    // Move to next weekday
    let nextDay = moment.unix(startUnix).tz(tz).add(1, "day");
    while (nextDay.day() === 0 || nextDay.day() === 6) {
      nextDay.add(1, "day");
    }
    const nextStart = nextDay
      .hour(START)
      .minute(0)
      .second(0)
      .millisecond(0)
      .unix();
    const nextEnd = nextStart + WINDOW_LEN_SECS;
    // Recursively find slot in next window
    return findNextSlot(nextStart, nextEnd, tz);
  }

  return nextSlot;
}

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

    const qnow = getQuebecNow();
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
    let scheduledUnix;
    const startUnix = nextInsideWindowUnixQuebec();
    const endUnix = startUnix + WINDOW_LEN_SECS;

    if (forceNow || ignoreWindow) {
      // Immediate call: 2 minutes from now
      scheduledUnix = nowUnix + 120;
    } else {
      // Schedule within window, with gap
      const isInsideWindowNow = nowUnix >= startUnix && nowUnix <= endUnix;
      let targetUnix = isInsideWindowNow ? nowUnix + 120 : startUnix;
      let targetMoment = moment.unix(targetUnix).tz(tzForLead);

      // Skip weekends
      while (targetMoment.day() === 0 || targetMoment.day() === 6) {
        targetMoment
          .add(1, "day")
          .hour(START)
          .minute(0)
          .second(0)
          .millisecond(0);
      }
      targetUnix = targetMoment.unix();
      const targetEndUnix = targetMoment
        .clone()
        .hour(END)
        .minute(0)
        .second(0)
        .millisecond(0)
        .unix();

      // Find next available slot with 5-minute gap
      scheduledUnix = await findNextSlot(targetUnix, targetEndUnix, tzForLead);
    }

    const scheduledAt = new Date(scheduledUnix * 1000);

    // Save lead + call attempt
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

    // Respond
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

    // Background tasks with 2-minute delay
    setTimeout(async () => {
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
              .then(() =>
                console.log(
                  `[INTAKE] email sent to ${email} after 2-minute delay`
                )
              )
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
            .then(() =>
              console.log(`[INTAKE] SMS sent to ${phone} after 2-minute delay`)
            )
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
                  scheduledUnix,
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
    }, 120000); // 2-minute delay (120 seconds)
  } catch (e) {
    console.error("[INTAKE error]", e);
    return res.status(500).json({ ok: false, error: "intake_failed" });
  }
});

export default r;
