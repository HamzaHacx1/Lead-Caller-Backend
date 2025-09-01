import { PrismaClient } from "@prisma/client";
import moment from "moment-timezone";
import { Router } from "express";

import {
  START,
  END,
  WINDOW_LEN_SECS,
  nextInsideWindowUnixQuebec,
  nextInsideWindowUnix,
  pickTz,
} from "../lib/schedule.js";
import { renderTemplate } from "../helpers/renderTemplates.js";
import { getQuebecNow, QUEBEC_TZ } from "../lib/quebecTime.js";
import { sendEmail, sendSMS } from "../helpers/notify.js";
import { callOutbound } from "../lib/elevenlabs.js";

const prisma = new PrismaClient();
const r = Router();

/** Find next available slot with a 5-minute gap */
export async function findNextSlot(startUnix, endUnix, tz) {
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

  // Ensure slot is within window and not on weekend
  const slotMoment = moment.unix(nextSlot).tz(tz);
  if (nextSlot > endUnix || slotMoment.hour() < 9 || slotMoment.hour() >= 19) {
    let nextDay = slotMoment.clone().add(1, "day");
    while (nextDay.day() === 0 || nextDay.day() === 6) {
      nextDay.add(1, "day");
    }
    const nextStart = nextDay.hour(9).minute(0).second(0).millisecond(0).unix();
    const nextEnd = nextStart + (19 - 9) * 3600; // 10 hours in seconds
    return findNextSlot(nextStart, nextEnd, tz); // Recurse with new window
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

    // Input validation
    if (!full_name || !phone) {
      return res
        .status(400)
        .json({ ok: false, error: "missing_name_or_phone" });
    }
    const sanitizedName = sanitizeHtml(full_name, {
      allowedTags: [],
      allowedAttributes: {},
    });
    const sanitizedPhone = sanitizeHtml(phone, {
      allowedTags: [],
      allowedAttributes: {},
    }).replace(/[^\d+]/g, "");
    const sanitizedEmail = email
      ? sanitizeHtml(email, { allowedTags: [], allowedAttributes: {} })
      : null;
    if (
      sanitizedPhone.length < 10 ||
      (sanitizedEmail && !/\S+@\S+\.\S+/.test(sanitizedEmail))
    ) {
      return res
        .status(400)
        .json({ ok: false, error: "invalid_phone_or_email" });
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

    // Use lead's timezone or QUEBEC_TZ
    const tzForLead = pickTz(timezone) || process.env.DEFAULT_TZ || QUEBEC_TZ;

    // Determine scheduling time
    let scheduledUnix;
    if (forceNow || ignoreWindow) {
      // Immediate call: 2 minutes from now
      scheduledUnix = nowUnix + 120;
    } else {
      // Schedule within window, respecting lead's timezone
      const startUnix = await nextInsideWindowUnix(tzForLead);
      const endUnix = startUnix + WINDOW_LEN_SECS;
      const isInsideWindowNow = nowUnix >= startUnix && nowUnix <= endUnix;
      let targetUnix = isInsideWindowNow ? nowUnix + 120 : startUnix;
      scheduledUnix = await findNextSlot(targetUnix, endUnix, tzForLead);
    }

    const scheduledAt = new Date(scheduledUnix * 1000);

    // Save lead + call attempt
    const lead = await prisma.lead.create({
      data: {
        fbLeadId: fbLeadId || null,
        fullName: sanitizedName,
        phone: sanitizedPhone,
        email: sanitizedEmail,
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
        .tz(tzForLead)
        .format("YYYY-MM-DD HH:mm:ss z"),
      window_tz: tzForLead,
      window_hours: { start: START, end: END },
    });

    // Background tasks with 2-minute delay
    setTimeout(async () => {
      try {
        const tasks = [];

        if (sanitizedEmail) {
          const html = renderTemplate("notify.html", {
            dashboard_link: "https://emploirapide.ca/documents",
          });
          tasks.push(
            sendEmail({
              to: sanitizedEmail,
              subject: "Tu veux un job ? Il te reste une seule étape !",
              html,
              text: `Salut 👋\n\nTu viens de remplir notre formulaire 🙌\nBonne nouvelle : finalise ton inscription ici : ${process.env.DASHBOARD_URL}/complete-profile\n\nÀ bientôt !`,
            })
              .then(() =>
                console.log(`[INTAKE] email sent to ${sanitizedEmail}`)
              )
              .catch((err) =>
                console.error("[INTAKE] sendEmail failed:", err.message)
              )
          );
        }

        tasks.push(
          sendSMS({
            to: sanitizedPhone,
            body: `T’as commencé ton inscription, mais ton profil est incomplet. On t’a renvoyé le courriel. Pense à vérifier les spams si jamais.`,
          })
            .then(() => console.log(`[INTAKE] SMS sent to ${sanitizedPhone}`))
            .catch((err) =>
              console.error("[INTAKE] sendSMS failed:", err.message)
            )
        );

        // Outbound call check
        const startLocal = moment
          .unix(scheduledUnix)
          .tz(tzForLead)
          .hour(START)
          .minute(0)
          .second(0);
        const endLocal = moment
          .unix(scheduledUnix)
          .tz(tzForLead)
          .hour(END)
          .minute(0)
          .second(0);
        const isInsideWindowNow =
          moment.unix(nowUnix).tz(tzForLead).isSameOrAfter(startLocal) &&
          moment.unix(nowUnix).tz(tzForLead).isSameOrBefore(endLocal);
        const vmFlag =
          Boolean(variables?.voicemailDetected) ||
          Boolean(metadata?.voicemailDetected) ||
          Boolean(variables?.hangup_on_voicemail) ||
          Boolean(metadata?.hangup_on_voicemail);

        if (!vmFlag && (ignoreWindow || forceNow || isInsideWindowNow)) {
          tasks.push(
            callOutbound({
              to: sanitizedPhone,
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
