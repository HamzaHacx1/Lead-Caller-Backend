import { PrismaClient } from "@prisma/client";
import sanitizeHtml from "sanitize-html";
import moment from "moment-timezone";
import { Router } from "express";

import {
  START,
  END,
  WINDOW_LEN_SECS,
  nextInsideWindowUnix,
  pickTz,
} from "../lib/schedule.js";
import { renderTemplate } from "../helpers/renderTemplates.js";
import { sendEmail, sendSMS } from "../helpers/notify.js";
import { nowIn, QUEBEC_TZ } from "../lib/quebecTime.js";
import { callOutbound } from "../lib/elevenlabs.js";

const prisma = new PrismaClient();
const r = Router();

/** Compute today's [start,end) window (moment objects) in a tz */
function todayWindow(tz) {
  const now = moment().tz(tz);
  const start = now.clone().hour(START).minute(0).second(0).millisecond(0);
  const end = now.clone().hour(END).minute(0).second(0).millisecond(0);
  return { start, end, now };
}

/** Find next available slot with a 5-minute gap (respects window & weekends) */
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

  // Weekend skip
  const slotMoment = moment.unix(nextSlot).tz(tz);
  const weekday = slotMoment.day();
  if (weekday === 0 || weekday === 6) {
    let nextDay = slotMoment
      .clone()
      .add(1, "day")
      .hour(START)
      .minute(0)
      .second(0)
      .millisecond(0);
    while (nextDay.day() === 0 || nextDay.day() === 6)
      nextDay = nextDay.add(1, "day");
    const nextStart = nextDay.unix();
    const nextEnd = nextStart + (END - START) * 3600;
    return findNextSlot(nextStart, nextEnd, tz);
  }

  // After hours skip
  const hour = slotMoment.hour();
  if (nextSlot > endUnix || hour < START || hour >= END) {
    let nextDay = slotMoment
      .clone()
      .add(1, "day")
      .hour(START)
      .minute(0)
      .second(0)
      .millisecond(0);
    while (nextDay.day() === 0 || nextDay.day() === 6)
      nextDay = nextDay.add(1, "day");
    const nextStart = nextDay.unix();
    const nextEnd = nextStart + (END - START) * 3600;
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

    const qcNow = nowIn(QUEBEC_TZ);
    const nowUnix = qcNow.unix();

    // Dedup
    if (fbLeadId) {
      const exists = await prisma.lead.findUnique({ where: { fbLeadId } });
      if (exists) {
        console.log("[INTAKE] deduped -> leadId", exists.id);
        return res.json({ ok: true, deduped: true, leadId: exists.id });
      }
    }

    const tzForLead = pickTz(timezone) || process.env.DEFAULT_TZ || QUEBEC_TZ;

    // Scheduling
    let scheduledUnix;
    if (forceNow || ignoreWindow) {
      scheduledUnix = nowUnix + 120;
    } else {
      const { start, end, now } = todayWindow(tzForLead);
      const insideNow = now.isSameOrAfter(start) && now.isBefore(end);

      let startUnix = await nextInsideWindowUnix(tzForLead);
      let endUnix = startUnix + WINDOW_LEN_SECS;

      const targetUnix = insideNow ? now.add(2, "minutes").unix() : startUnix;
      scheduledUnix = await findNextSlot(targetUnix, endUnix, tzForLead);
    }

    const scheduledAt = new Date(scheduledUnix * 1000);

    // Create lead
    const lead = await prisma.lead.create({
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

    // Ensure attempt #1 exists or is updated
    await prisma.callAttempt.upsert({
      where: {
        leadId_attemptNumber: { leadId: lead.id, attemptNumber: 1 },
      },
      create: {
        leadId: lead.id,
        attemptNumber: 1,
        status: "SCHEDULED",
        scheduledAt,
      },
      update: { scheduledAt },
    });

    // Update lead with attempt count
    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        attempts: 1,
        lastAttemptAt: scheduledAt,
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

    // Background tasks after 2 minutes
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
          );
        }

        tasks.push(
          sendSMS({
            to: sanitizedPhone,
            body: `T’as commencé ton inscription, mais ton profil est incomplet. On t’a renvoyé le courriel. Pense à vérifier les spams si jamais.`,
          })
        );

        // Outbound call if allowed
        const { start, end, now } = todayWindow(tzForLead);
        const insideNow = now.isSameOrAfter(start) && now.isBefore(end);
        const vmFlag =
          Boolean(variables?.voicemailDetected) ||
          Boolean(metadata?.voicemailDetected) ||
          Boolean(variables?.hangup_on_voicemail) ||
          Boolean(metadata?.hangup_on_voicemail);

        if (!vmFlag && (ignoreWindow || forceNow || insideNow)) {
          tasks.push(
            callOutbound({
              to: sanitizedPhone,
              lead: { ...lead, scheduledUnix },
              attemptNumber: 1,
              variables,
            })
          );
        }

        await Promise.allSettled(tasks);
      } catch (err) {
        console.error("[INTAKE background error]", err);
      }
    }, 120000);
  } catch (e) {
    console.error("[INTAKE error]", e);
    return res.status(500).json({ ok: false, error: "intake_failed" });
  }
});

export default r;
