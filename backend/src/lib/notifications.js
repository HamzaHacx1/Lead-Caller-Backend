import sanitizeHtml from "sanitize-html";
import moment from "moment-timezone";

import { renderTemplate as renderHbsFile } from "../helpers/renderTemplates.js";
import { sendEmail, sendSMS } from "../helpers/notify.js";
import { START, END, pickTz } from "../lib/schedule.js";
import { QUEBEC_TZ } from "../lib/quebecTime.js";
import prisma from "./prisma.js";

const { SUPPORT_NUMBER, APP_NAME = "EmploiRapide" } = process.env;
const BOOKING_URL =
  process.env.BOOKING_URL || "https://emploirapide.ca/documents";

// -----------------------------------------------------------------------------
// Window helpers (lead's timezone, not hardcoded Québec)
// -----------------------------------------------------------------------------
function isWeekendAt(date, tz) {
  console.debug(
    `[DEBUG] isWeekendAt: Checking if ${date} in timezone ${tz} is a weekend`
  );
  const d = moment(date).tz(tz).day();
  const isWeekend = d === 0 || d === 6;
  console.debug(`[DEBUG] isWeekendAt: Day is ${d}, isWeekend: ${isWeekend}`);
  return isWeekend;
}

function isInsideWindowAt(date, tz, startHour = START, endHour = END) {
  console.debug(
    `[DEBUG] isInsideWindowAt: Checking if ${date} in timezone ${tz} is within window ${startHour}-${endHour}`
  );
  const m = moment(date).tz(tz);
  const h = m.hour();
  const isInside = !isWeekendAt(date, tz) && h >= startHour && h < endHour;
  console.debug(
    `[DEBUG] isInsideWindowAt: Hour is ${h}, isWeekend: ${isWeekendAt(
      date,
      tz
    )}, isInside: ${isInside}`
  );
  return isInside;
}

/** Roll forward to next valid business instant (start of day if outside). */
function rollForwardToWindowDate(date, tz, startHour = START) {
  console.debug(
    `[DEBUG] rollForwardToWindowDate: Rolling forward ${date} in timezone ${tz} to startHour ${startHour}`
  );
  let m = moment(date).tz(tz);
  console.debug(
    `[DEBUG] rollForwardToWindowDate: Initial moment: ${m.format()}`
  );

  // If weekend → move to next Monday @ startHour
  while (isWeekendAt(m, tz)) {
    console.debug(
      `[DEBUG] rollForwardToWindowDate: Date ${m.format()} is a weekend, advancing by 1 day`
    );
    m = m.add(1, "day");
  }

  // If before window start → set to startHour today
  if (m.hour() < startHour) {
    console.debug(
      `[DEBUG] rollForwardToWindowDate: Hour ${m.hour()} is before ${startHour}, setting to ${startHour}:00`
    );
    m = m.hour(startHour).minute(0).second(0).millisecond(0);
  }

  // If after window end → next business day @ startHour
  if (!isInsideWindowAt(m, tz)) {
    console.debug(
      `[DEBUG] rollForwardToWindowDate: Date ${m.format()} is outside window, moving to next day at ${startHour}:00`
    );
    m = m.add(1, "day").hour(startHour).minute(0).second(0).millisecond(0);
    while (isWeekendAt(m, tz)) {
      console.debug(
        `[DEBUG] rollForwardToWindowDate: Next day ${m.format()} is a weekend, advancing by 1 day`
      );
      m = m.add(1, "day");
    }
  }

  const result = m.toDate();
  console.debug(
    `[DEBUG] rollForwardToWindowDate: Final rolled date: ${result}`
  );
  return result;
}

// -----------------------------------------------------------------------------
// Idempotent step marker (prevents double-scheduling/sending)
// -----------------------------------------------------------------------------
async function ensureOnce(leadId, step) {
  console.debug(
    `[DEBUG] ensureOnce: Checking idempotency for leadId ${leadId}, step ${step}`
  );
  try {
    const result = await prisma.$transaction(async (tx) => {
      console.debug(
        `[DEBUG] ensureOnce: Starting transaction for leadId ${leadId}, step ${step}`
      );
      const existing = await tx.notificationEvent.findFirst({
        where: { leadId, step },
      });
      console.debug(
        `[DEBUG] ensureOnce: Existing notification: ${JSON.stringify(existing)}`
      );

      if (existing) {
        console.debug(
          `[DEBUG] ensureOnce: Notification already exists for leadId ${leadId}, step ${step}`
        );
        throw new Error("Notification already scheduled");
      }

      const created = await tx.notificationEvent.create({
        data: { leadId, step },
      });
      console.debug(
        `[DEBUG] ensureOnce: Created notification event: ${JSON.stringify(
          created
        )}`
      );
      return true;
    });
    console.debug(
      `[DEBUG] ensureOnce: Transaction successful, result: ${result}`
    );
    return result;
  } catch (e) {
    console.warn(
      `[NOTIFY] ensureOnce failed for ${leadId}/${step}: ${e.message}`
    );
    console.debug(`[DEBUG] ensureOnce: Error details: ${JSON.stringify(e)}`);
    return false;
  }
}

// -----------------------------------------------------------------------------
// Small validators
// -----------------------------------------------------------------------------
function hasEmail(lead) {
  console.debug(
    `[DEBUG] hasEmail: Checking email for lead: ${JSON.stringify(lead)}`
  );
  const email = (lead?.email ?? "").trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;
  const isValid =
    Boolean(email) && emailRegex.test(email) && !email.includes(";");
  console.debug(`[DEBUG] hasEmail: Email: ${email}, isValid: ${isValid}`);
  return isValid;
}

function hasPhone(lead) {
  console.debug(
    `[DEBUG] hasPhone: Checking phone for lead: ${JSON.stringify(lead)}`
  );
  const phone = lead?.phone ? String(lead.phone).trim() : "";
  const isValid = phone.length >= 6 && !phone.includes(";");
  console.debug(`[DEBUG] hasPhone: Phone: ${phone}, isValid: ${isValid}`);
  return isValid;
}

// -----------------------------------------------------------------------------
// Copy
// -----------------------------------------------------------------------------
function getAttemptCopy(step, isAnswered = false) {
  console.debug(
    `[DEBUG] getAttemptCopy: Fetching copy for step ${step}, isAnswered: ${isAnswered}`
  );
  const sanitize = (text) => {
    console.debug(`[DEBUG] getAttemptCopy: Sanitizing text: ${text}`);
    const sanitized = sanitizeHtml(text, {
      allowedTags: [],
      allowedAttributes: {},
    });
    console.debug(`[DEBUG] getAttemptCopy: Sanitized text: ${sanitized}`);
    return sanitized;
  };

  if (isAnswered) {
    if (step === "ANSWERED_24H") {
      const copy = {
        subject: sanitize("T’as ton CV à portée de main ?"),
        title: sanitize("On t’attend encore"),
        cta_text: sanitize("👉 Compléter mon dossier"),
        bodyText: sanitize(`
          <p>On a vu que t’as commencé ton inscription…</br>
          Mais ton profil est encore bloqué à l’étape 1 😬</br>
          Il te reste à :</br>
          <ul>
            <li>✅ Ajouter ton CV</li>
            <li>✅ Joindre un spécimen de chèque</li>
          </ul></p>`),
        cta_link: BOOKING_URL,
        closingText: sanitize(
          "Pas de stress. Juste une p’tite étape de plus, et tu pourras recevoir des offres. On garde ta place au chaud 🔥"
        ),
        smsBody: () =>
          sanitize(
            `T’as commencé ton inscription, mais ton profil est incomplet. On t’a renvoyé le courriel. Pense à vérifier les spams si jamais.`
          ),
      };
      console.debug(
        `[DEBUG] getAttemptCopy: Returning copy for ANSWERED_24H: ${JSON.stringify(
          copy
        )}`
      );
      return copy;
    }
    if (step === "ANSWERED_48H") {
      const copy = {
        subject: sanitize(
          "On peut pas t’aider tant que ton profil est en pause"
        ),
        title: sanitize("Dernier rappel !"),
        cta_text: sanitize("👉 Compléter mon dossier"),
        cta_link: BOOKING_URL,
        bodyText: sanitize(`
          <p>Ton inscription est bien commencée… mais sans CV ni spécimen de chèque, on ne peut pas avancer.
          C’est comme vouloir passer une entrevue sans se présenter 😅</p>
          <p>Sinon, ton compte va rester en veille. Tu pourras toujours revenir plus tard, mais tu vas manquer des opportunités maintenant.</p>`),
        closingText: sanitize("On est prêts quand toi tu l’es 💼"),
        smsBody: () =>
          sanitize(
            `Dernier rappel : on t’a écrit pour finaliser ton profil. Jette un œil dans ta boîte courriel (et dans les indésirables aussi!).`
          ),
      };
      console.debug(
        `[DEBUG] getAttemptCopy: Returning copy for ANSWERED_48H: ${JSON.stringify(
          copy
        )}`
      );
      return copy;
    }
    if (step === "ANSWERED_15M") {
      const copy = {
        subject: sanitize("T’as ton CV prêt ?"),
        title: sanitize("On t’attend pour finaliser"),
        cta_text: sanitize("👉 Compléter mon dossier"),
        bodyText: sanitize(`
          <p>Tu viens de commencer ton inscription…</br>
          Ton profil est encore à l’étape 1 😬</br>
          Il te reste à :</br>
          <ul>
            <li>✅ Ajouter ton CV</li>
            <li>✅ Joindre un spécimen de chèque</li>
          </ul></p>`),
        cta_link: BOOKING_URL,
        closingText: sanitize(
          "Juste une petite étape et t’es prêt pour des offres ! 🔥"
        ),
        smsBody: () =>
          sanitize(
            `Ton profil est incomplet. Check ton courriel pour finaliser (vérifie les spams !).`
          ),
      };
      console.debug(
        `[DEBUG] getAttemptCopy: Returning copy for ANSWERED_15M: ${JSON.stringify(
          copy
        )}`
      );
      return copy;
    }
    if (step === "ANSWERED_30M") {
      const copy = {
        subject: sanitize("Ton profil est en attente !"),
        title: sanitize("Dernier rappel rapide !"),
        cta_text: sanitize("👉 Compléter mon dossier"),
        cta_link: BOOKING_URL,
        bodyText: sanitize(`
          <p>Ton inscription est en cours, mais sans CV ni spécimen de chèque, on ne peut pas avancer.</p>
          <p>Finalise vite pour ne pas rater des opportunités !</p>`),
        closingText: sanitize("On t’attend 💼"),
        smsBody: () =>
          sanitize(
            `Rappel : finalise ton profil ! Vérifie ton courriel (et les spams).`
          ),
      };
      console.debug(
        `[DEBUG] getAttemptCopy: Returning copy for ANSWERED_30M: ${JSON.stringify(
          copy
        )}`
      );
      return copy;
    }
  }

  // Defaults for NO_ANSWER series
  const base = {
    subject: sanitize("J’ai tenté de t’appeler pour ta job 🚀"),
    title: sanitize("J’ai tenté de t’appeler pour ta job 🚀"),
    cta_text: sanitize("➡️ Compléter mon inscription"),
    cta_link: BOOKING_URL,
    bodyText: sanitize(`
      <p>Salut,</p>
      <p><strong>J’ai essayé de t’appeler aujourd’hui</strong> pour avancer dans ta recherche d’emploi, mais je n’ai pas réussi à te joindre.</p>
      <p>Pas de souci — tu peux compléter ton inscription en ligne (3 minutes) :</p>`),
    closingText: sanitize("À bientôt !"),
    smsBody: () =>
      sanitize(
        `Simon d’${APP_NAME} — J’ai tenté de t’appeler pour ta recherche d’emploi. Rappelle moi !`
      ),
  };

  if (step === "AFTER_2_NO_ANSWER") {
    const copy = {
      subject: sanitize("Toujours pas eu de nouvelles 📞"),
      title: sanitize("Toujours pas eu de nouvelles 📞"),
      cta_text: sanitize("Compléter mon inscription"),
      cta_link: BOOKING_URL,
      bodyText: sanitize(
        `<p>Tu peux gagner du temps en complétant ton inscription directement ici :</p>`
      ),
      closingText: sanitize(
        "On pourra ainsi te proposer des postes plus rapidement. À très vite !"
      ),
      smsBody: () =>
        sanitize(
          `Simon d’${APP_NAME} ici — je n’ai toujours pas eu ton appel. Peux-tu me rappeler ? 📞`
        ),
    };
    console.debug(
      `[DEBUG] getAttemptCopy: Returning copy for AFTER_2_NO_ANSWER: ${JSON.stringify(
        copy
      )}`
    );
    return copy;
  }
  if (step === "AFTER_3_NO_ANSWER") {
    const copy = {
      subject: sanitize("Dernier suivi — on met en pause si pas de nouvelles"),
      title: sanitize("Dernière tentative"),
      subtitle: sanitize("On aimerait vraiment t’aider 🚀"),
      cta_link: BOOKING_URL,
      cta_text: sanitize("➡️ DÉMARRER MA CANDIDATURE"),
      bodyText: sanitize(`
        <p>C’est la 3<sup>e</sup> fois qu’on essaye de t’appeler sans succès.</p>
        <p>Si tu veux toujours un job rapidement, il te suffit de compléter ton profil :</p>`),
      closingText: sanitize("Merci et à bientôt !"),
      smsBody: () => sanitize(`As-tu toujours besoin d’un emploi ?`),
    };
    console.debug(
      `[DEBUG] getAttemptCopy: Returning copy for AFTER_3_NO_ANSWER: ${JSON.stringify(
        copy
      )}`
    );
    return copy;
  }
  if (step === "AFTER_2_NO_ANSWER_QUICK") {
    const copy = {
      subject: sanitize("Toujours pas de nouvelles 📞"),
      title: sanitize("Toujours pas de nouvelles 📞"),
      cta_text: sanitize("Compléter mon inscription"),
      cta_link: BOOKING_URL,
      bodyText: sanitize(`<p>Complète ton inscription ici pour avancer :</p>`),
      closingText: sanitize(
        "On peut te proposer des postes rapidement. À tout de suite !"
      ),
      smsBody: () =>
        sanitize(
          `Simon d’${APP_NAME} — Pas eu ton appel. Rappelle-moi vite ! 📞`
        ),
    };
    console.debug(
      `[DEBUG] getAttemptCopy: Returning copy for AFTER_2_NO_ANSWER_QUICK: ${JSON.stringify(
        copy
      )}`
    );
    return copy;
  }
  if (step === "AFTER_3_NO_ANSWER_QUICK") {
    const copy = {
      subject: sanitize("Dernier rappel — on met en pause"),
      title: sanitize("Dernier rappel rapide"),
      subtitle: sanitize("On veut t’aider 🚀"),
      cta_link: BOOKING_URL,
      cta_text: sanitize("➡️ DÉMARRER MA CANDIDATURE"),
      bodyText: sanitize(`
        <p>3<sup>e</sup> tentative d’appel sans réponse.</p>
        <p>Complète ton profil pour avancer :</p>`),
      closingText: sanitize("Merci et à bientôt !"),
      smsBody: () => sanitize(`Toujours à la recherche d’un emploi ?`),
    };
    console.debug(
      `[DEBUG] getAttemptCopy: Returning copy for AFTER_3_NO_ANSWER_QUICK: ${JSON.stringify(
        copy
      )}`
    );
    return copy;
  }

  console.debug(
    `[DEBUG] getAttemptCopy: Returning default base copy: ${JSON.stringify(
      base
    )}`
  );
  return base;
}

// -----------------------------------------------------------------------------
// Sender
// -----------------------------------------------------------------------------
async function sendEmailAndSMS({ lead, subject, context, smsBody, skipEmail }) {
  console.debug(
    `[DEBUG] sendEmailAndSMS: Starting for leadId ${lead?.id}, subject: ${subject}, skipEmail: ${skipEmail}`
  );
  const baseCtx = {
    appName: APP_NAME,
    bookingUrl: BOOKING_URL,
    supportNumber: SUPPORT_NUMBER || "",
    lead,
    ...context,
  };
  console.debug(`[DEBUG] sendEmailAndSMS: Context: ${JSON.stringify(baseCtx)}`);

  // Email
  if (!skipEmail && hasEmail(lead)) {
    try {
      console.debug(
        `[DEBUG] sendEmailAndSMS: Rendering email template for leadId ${lead.id}`
      );
      const html = renderHbsFile("no_answer_base.hbs", baseCtx);
      console.debug(
        `[DEBUG] sendEmailAndSMS: Email HTML generated, length: ${html.length}`
      );
      await sendEmail({ to: String(lead.email).trim(), subject, html });
      console.log("[NOTIFY:email] sent", { leadId: lead.id });
    } catch (e) {
      console.warn("[NOTIFY:email] failed", e?.message);
      console.debug(`[DEBUG] sendEmailAndSMS: Email send failed: ${e.message}`);
    }
  } else {
    console.log("[NOTIFY:email] skipped", {
      leadId: lead?.id,
      reason: skipEmail ? "forced skip" : "no email",
    });
    console.debug(
      `[DEBUG] sendEmailAndSMS: Email skipped, reason: ${
        skipEmail ? "forced skip" : "no email"
      }`
    );
  }

  // SMS
  if (hasPhone(lead) && smsBody) {
    try {
      const to = String(lead.phone).trim();
      console.debug(`[DEBUG] sendEmailAndSMS: Preparing SMS for ${to}`);
      const body =
        typeof smsBody === "function" ? smsBody(baseCtx) : String(smsBody);
      console.debug(`[DEBUG] sendEmailAndSMS: SMS body: ${body}`);
      if (body) {
        await sendSMS({ to, body });
        console.log("[NOTIFY:sms] sent", { leadId: lead.id });
      }
    } catch (e) {
      console.warn("[NOTIFY:sms] failed", e?.message);
      console.debug(`[DEBUG] sendEmailAndSMS: SMS send failed: ${e.message}`);
    }
  }
}

// -----------------------------------------------------------------------------
// Scheduling (correct tz + window, no hardcoded Québec checks)
// -----------------------------------------------------------------------------
async function scheduleDelayedNotifications(lead) {
  console.debug(
    `[DEBUG] scheduleDelayedNotifications: Starting for leadId ${lead.id}`
  );
  const tz = pickTz(lead.timezone || QUEBEC_TZ);
  console.debug(`[DEBUG] scheduleDelayedNotifications: Using timezone ${tz}`);
  const now = moment().tz(tz);
  console.debug(
    `[DEBUG] scheduleDelayedNotifications: Current time: ${now.format()}`
  );

  // TESTING: For testing, schedule at 2-min intervals
  const plans = [
    { step: "ANSWERED_24H", delayMs: 2 * 60 * 1000 }, // 2 minutes
    { step: "ANSWERED_48H", delayMs: 4 * 60 * 1000 }, // 4 minutes
  ];

  for (const p of plans) {
    console.debug(
      `[DEBUG] scheduleDelayedNotifications: Processing plan for step ${p.step}, delay ${p.delayMs}ms`
    );
    const target = now.clone().add(p.delayMs, "milliseconds").toDate();
    console.debug(
      `[DEBUG] scheduleDelayedNotifications: Target time: ${target}`
    );
    const created = await prisma.notificationEvent.create({
      data: {
        leadId: lead.id,
        step: p.step,
        scheduledAt: target, // No window clamping for testing
        metadata: { attemptNumber: 1 },
      },
    });
    console.debug(
      `[DEBUG] scheduleDelayedNotifications: Created notification event: ${JSON.stringify(
        created
      )}`
    );
  }

  // ORIGINAL: Comment out for testing; restore after
  /*
  const plans = [
    { step: "ANSWERED_24H", delayMs: 24 * 60 * 60 * 1000 },
    { step: "ANSWERED_48H", delayMs: 48 * 60 * 60 * 1000 },
  ];

  for (const p of plans) {
    const target = now.clone().add(p.delayMs, "milliseconds").toDate();
    const scheduledAt = rollForwardToWindowDate(target, tz, START);
    await prisma.notificationEvent.create({
      data: {
        leadId: lead.id,
        step: p.step,
        scheduledAt,
        metadata: { attemptNumber: 1 },
      },
    });
  }
  */
}

async function scheduleQuickNotifications(lead) {
  console.debug(
    `[DEBUG] scheduleQuickNotifications: Starting for leadId ${lead.id}`
  );
  const tz = pickTz(lead.timezone || QUEBEC_TZ);
  console.debug(`[DEBUG] scheduleQuickNotifications: Using timezone ${tz}`);
  const now = moment().tz(tz);
  console.debug(
    `[DEBUG] scheduleQuickNotifications: Current time: ${now.format()}`
  );

  // Keep step keys; shorten timings for quick tests
  const plans = [
    { step: "ANSWERED_15M", delayMs: 3 * 60 * 1000 }, // 3 minutes
    { step: "ANSWERED_30M", delayMs: 6 * 60 * 1000 }, // 6 minutes
  ];

  for (const p of plans) {
    console.debug(
      `[DEBUG] scheduleQuickNotifications: Processing plan for step ${p.step}, delay ${p.delayMs}ms`
    );
    const target = now.clone().add(p.delayMs, "milliseconds").toDate();
    console.debug(`[DEBUG] scheduleQuickNotifications: Target time: ${target}`);
    // If you want strict business-hours clamping during tests, swap `target` with:
    // const scheduledAt = rollForwardToWindowDate(target, tz, START);
    const created = await prisma.notificationEvent.create({
      data: {
        leadId: lead.id,
        step: p.step,
        scheduledAt: target,
        metadata: { attemptNumber: 1 },
      },
    });
    console.debug(
      `[DEBUG] scheduleQuickNotifications: Created notification event: ${JSON.stringify(
        created
      )}`
    );
  }

  // ORIGINAL: Comment out for testing; restore after
  /*
  const plans = [
    { step: "ANSWERED_15M", delayMs: 15 * 60 * 1000 },
    { step: "ANSWERED_30M", delayMs: 30 * 60 * 1000 },
  ];

  for (const p of plans) {
    const target = now.clone().add(p.delayMs, "milliseconds").toDate();
    const scheduledAt = rollForwardToWindowDate(target, tz, START);
    await prisma.notificationEvent.create({
      data: {
        leadId: lead.id,
        step: p.step,
        scheduledAt,
        metadata: { attemptNumber: 1 },
      },
    });
  }
  */
}

// -----------------------------------------------------------------------------
// Public APIs used by webhook
// -----------------------------------------------------------------------------
export async function handleAttemptNotifications({
  lead,
  attemptNumber,
  outcome,
}) {
  console.debug(
    `[DEBUG] handleAttemptNotifications: Starting for leadId ${lead?.id}, attemptNumber ${attemptNumber}, outcome ${outcome}`
  );
  console.log("inside handleAttemptNotifications :start");
  if (!lead?.id) {
    console.debug(`[DEBUG] handleAttemptNotifications: No lead ID, exiting`);
    return;
  }
  console.log("[NOTIFY] handleAttempt", {
    leadId: lead.id,
    attemptNumber,
    outcome,
  });

  const valid = ["ANSWERED", "NO_ANSWER"];
  if (!valid.includes(outcome)) {
    console.warn(`[NOTIFY] Invalid outcome ${outcome} for lead ${lead.id}`);
    console.debug(
      `[DEBUG] handleAttemptNotifications: Invalid outcome ${outcome}, exiting`
    );
    return;
  }

  if (outcome === "ANSWERED") {
    console.debug(
      `[DEBUG] handleAttemptNotifications: Outcome is ANSWERED, scheduling delayed notifications`
    );
    console.log("inside handleAttemptNotifications :if answered block");
    await scheduleDelayedNotifications(lead);
    console.debug(
      `[DEBUG] handleAttemptNotifications: Delayed notifications scheduled for leadId ${lead.id}`
    );
    return;
  }

  // TESTING: For testing, send NO_ANSWER notifications immediately or schedule at 2-min intervals
  if (attemptNumber >= 1 && attemptNumber <= 3) {
    const step = `AFTER_${attemptNumber}_NO_ANSWER`;
    console.debug(
      `[DEBUG] handleAttemptNotifications: Processing NO_ANSWER step ${step}`
    );
    if (await ensureOnce(lead.id, `${step}_SCHEDULED`)) {
      console.debug(
        `[DEBUG] handleAttemptNotifications: Idempotency check passed for ${step}_SCHEDULED`
      );
      const copy = getAttemptCopy(step);
      const tz = pickTz(lead.timezone || QUEBEC_TZ);
      const now = moment().tz(tz);
      const delayMs = (attemptNumber - 1) * 2 * 60 * 1000; // 0, 2, 4 minutes
      const scheduledAt = now.clone().add(delayMs, "milliseconds").toDate();
      console.debug(
        `[DEBUG] handleAttemptNotifications: Scheduling for ${scheduledAt}, delay: ${delayMs}ms`
      );

      if (delayMs === 0) {
        console.debug(
          `[DEBUG] handleAttemptNotifications: Sending immediate notification for attempt ${attemptNumber}`
        );
        // Send immediately for first attempt
        await sendEmailAndSMS({
          lead,
          subject: copy.subject,
          smsBody: copy.smsBody,
          skipEmail: attemptNumber === 3,
          context: {
            attemptNumber,
            outcome,
            title: copy.title,
            subtitle: copy.subtitle,
            cta_text: copy.cta_text,
            cta_link: BOOKING_URL,
            bodyText: copy.bodyText,
            closingText: copy.closingText,
          },
        });
        console.debug(
          `[DEBUG] handleAttemptNotifications: Immediate notification sent for attempt ${attemptNumber}`
        );
      } else {
        console.debug(
          `[DEBUG] handleAttemptNotifications: Scheduling notification for later attempt ${attemptNumber}`
        );
        // Schedule for later attempts
        const created = await prisma.notificationEvent.create({
          data: {
            leadId: lead.id,
            step,
            scheduledAt,
            metadata: { attemptNumber },
          },
        });
        console.debug(
          `[DEBUG] handleAttemptNotifications: Scheduled notification: ${JSON.stringify(
            created
          )}`
        );
      }
    }
  }

  // ORIGINAL: Comment out for testing; restore after
  /*
  if (attemptNumber >= 1 && attemptNumber <= 3) {
    const step = `AFTER_${attemptNumber}_NO_ANSWER`;
    if (await ensureOnce(lead.id, step)) {
      const copy = getAttemptCopy(step);
      await sendEmailAndSMS({
        lead,
        subject: copy.subject,
        smsBody: copy.smsBody,
        skipEmail: attemptNumber === 3,
        context: {
          attemptNumber,
          outcome,
          title: copy.title,
          subtitle: copy.subtitle,
          cta_text: copy.cta_text,
          cta_link: BOOKING_URL,
          bodyText: copy.bodyText,
          closingText: copy.closingText,
        },
      });
    }
  }
  */
}

export async function handleQuickAttemptNotifications({
  lead,
  attemptNumber,
  outcome,
}) {
  console.debug(
    `[DEBUG] handleQuickAttemptNotifications: Starting for leadId ${lead?.id}, attemptNumber ${attemptNumber}, outcome ${outcome}`
  );
  if (!lead?.id) {
    console.debug(
      `[DEBUG] handleQuickAttemptNotifications: No lead ID, exiting`
    );
    return;
  }
  console.log("[NOTIFY] handleQuickAttempt", {
    leadId: lead.id,
    attemptNumber,
    outcome,
  });

  const valid = ["ANSWERED", "NO_ANSWER"];
  if (!valid.includes(outcome)) {
    console.warn(`[NOTIFY] Invalid outcome ${outcome} for lead ${lead.id}`);
    console.debug(
      `[DEBUG] handleQuickAttemptNotifications: Invalid outcome ${outcome}, exiting`
    );
    return;
  }

  if (outcome === "ANSWERED") {
    console.debug(
      `[DEBUG] handleQuickAttemptNotifications: Outcome is ANSWERED, scheduling quick notifications`
    );
    await scheduleQuickNotifications(lead);
    console.debug(
      `[DEBUG] handleQuickAttemptNotifications: Quick notifications scheduled for leadId ${lead.id}`
    );
    return;
  }

  // TESTING: For testing, send NO_ANSWER_QUICK notifications immediately or schedule at 2-min intervals
  if (outcome === "NO_ANSWER" && attemptNumber >= 1 && attemptNumber <= 3) {
    const step = `AFTER_${attemptNumber}_NO_ANSWER_QUICK`;
    console.debug(
      `[DEBUG] handleQuickAttemptNotifications: Processing NO_ANSWER_QUICK step ${step}`
    );
    if (await ensureOnce(lead.id, `${step}_SCHEDULED`)) {
      console.debug(
        `[DEBUG] handleQuickAttemptNotifications: Idempotency check passed for ${step}_SCHEDULED`
      );
      const copy = getAttemptCopy(step);
      const tz = pickTz(lead.timezone || QUEBEC_TZ);
      const now = moment().tz(tz);
      const delayMs = (attemptNumber - 1) * 3 * 60 * 1000; // 0, 3, 6 minutes
      const scheduledAt = now.clone().add(delayMs, "milliseconds").toDate();
      console.debug(
        `[DEBUG] handleQuickAttemptNotifications: Scheduling for ${scheduledAt}, delay: ${delayMs}ms`
      );

      if (delayMs === 0) {
        console.debug(
          `[DEBUG] handleQuickAttemptNotifications: Sending immediate notification for attempt ${attemptNumber}`
        );
        // Send immediately for first attempt
        await sendEmailAndSMS({
          lead,
          subject: copy.subject,
          smsBody: copy.smsBody,
          skipEmail: attemptNumber === 3,
          context: {
            attemptNumber,
            outcome,
            title: copy.title,
            subtitle: copy.subtitle,
            cta_text: copy.cta_text,
            cta_link: BOOKING_URL,
            bodyText: copy.bodyText,
            closingText: copy.closingText,
          },
        });
        console.debug(
          `[DEBUG] handleQuickAttemptNotifications: Immediate notification sent for attempt ${attemptNumber}`
        );
      } else {
        console.debug(
          `[DEBUG] handleQuickAttemptNotifications: Scheduling notification for later attempt ${attemptNumber}`
        );
        // Schedule for later attempts
        const created = await prisma.notificationEvent.create({
          data: {
            leadId: lead.id,
            step,
            scheduledAt,
            metadata: { attemptNumber },
          },
        });
        console.debug(
          `[DEBUG] handleQuickAttemptNotifications: Scheduled notification: ${JSON.stringify(
            created
          )}`
        );
      }
    }
  }

  // ORIGINAL: Comment out for testing; restore after
  /*
  if (outcome === "NO_ANSWER" && attemptNumber >= 1 && attemptNumber <= 3) {
    const step = `AFTER_${attemptNumber}_NO_ANSWER_QUICK`;
    if (await ensureOnce(lead.id, step)) {
      const copy = getAttemptCopy(step);
      await sendEmailAndSMS({
        lead,
        subject: copy.subject,
        smsBody: copy.smsBody,
        skipEmail: attemptNumber === 3,
        context: {
          attemptNumber,
          outcome,
          title: copy.title,
          subtitle: copy.subtitle,
          cta_text: copy.cta_text,
          cta_link: BOOKING_URL,
          bodyText: copy.bodyText,
          closingText: copy.closingText,
        },
      });
    }
  }
  */
}

// -----------------------------------------------------------------------------
// Worker to process due notifications (safe across multiple instances)
// -----------------------------------------------------------------------------
export async function processScheduledNotifications(limit = 200) {
  console.debug(
    `[DEBUG] processScheduledNotifications: Starting with limit ${limit}`
  );
  const now = new Date();
  console.debug(`[DEBUG] processScheduledNotifications: Current time: ${now}`);

  const notifications = await prisma.notificationEvent.findMany({
    where: {
      scheduledAt: { lte: now },
      step: {
        in: [
          // ANSWERED series (kept)
          "ANSWERED_24H",
          "ANSWERED_48H",
          "ANSWERED_15M",
          "ANSWERED_30M",
          // NEW: NO_ANSWER scheduled steps
          "AFTER_2_NO_ANSWER",
          "AFTER_3_NO_ANSWER",
          "AFTER_2_NO_ANSWER_QUICK",
          "AFTER_3_NO_ANSWER_QUICK",
        ],
      },
    },
    include: { lead: true },
    take: limit,
    orderBy: { scheduledAt: "asc" },
  });
  console.debug(
    `[DEBUG] processScheduledNotifications: Found ${notifications.length} notifications`
  );

  for (const n of notifications) {
    console.debug(
      `[DEBUG] processScheduledNotifications: Processing notification id ${n.id}, step ${n.step}`
    );
    try {
      console.debug(
        `[DEBUG] processScheduledNotifications: Attempting advisory lock for notification id ${n.id}`
      );
      const got =
        await prisma.$queryRaw`SELECT pg_try_advisory_xact_lock(${BigInt(
          n.id
        )}) AS ok;`;
      console.debug(
        `[DEBUG] processScheduledNotifications: Lock result: ${JSON.stringify(
          got
        )}`
      );
      if (!got?.[0]?.ok) {
        console.debug(
          `[DEBUG] processScheduledNotifications: Failed to acquire lock for id ${n.id}, skipping`
        );
        continue;
      }

      const attemptNumber = n.metadata?.attemptNumber || 1;
      console.debug(
        `[DEBUG] processScheduledNotifications: Attempt number: ${attemptNumber}`
      );

      if (["ANSWERED_24H", "ANSWERED_48H"].includes(n.step)) {
        console.debug(
          `[DEBUG] processScheduledNotifications: Processing ANSWERED step ${n.step}`
        );
        await processScheduledNotification(n.lead, n.step, attemptNumber);
      } else if (["ANSWERED_15M", "ANSWERED_30M"].includes(n.step)) {
        console.debug(
          `[DEBUG] processScheduledNotifications: Processing quick ANSWERED step ${n.step}`
        );
        await processQuickScheduledNotification(n.lead, n.step, attemptNumber);
      } else if (["AFTER_2_NO_ANSWER", "AFTER_3_NO_ANSWER"].includes(n.step)) {
        console.debug(
          `[DEBUG] processScheduledNotifications: Processing NO_ANSWER step ${n.step}`
        );
        await processNoAnswerScheduledNotification(
          n.lead,
          n.step,
          attemptNumber
        );
      } else if (
        ["AFTER_2_NO_ANSWER_QUICK", "AFTER_3_NO_ANSWER_QUICK"].includes(n.step)
      ) {
        console.debug(
          `[DEBUG] processScheduledNotifications: Processing quick NO_ANSWER step ${n.step}`
        );
        await processNoAnswerQuickScheduledNotification(
          n.lead,
          n.step,
          attemptNumber
        );
      }

      console.debug(
        `[DEBUG] processScheduledNotifications: Deleting notification id ${n.id}`
      );
      await prisma.notificationEvent.delete({ where: { id: n.id } });
      console.debug(
        `[DEBUG] processScheduledNotifications: Notification id ${n.id} deleted`
      );
    } catch (e) {
      console.warn(
        `[NOTIFY] processScheduledNotifications error id=${n.id}: ${e.message}`
      );
      console.debug(
        `[DEBUG] processScheduledNotifications: Error details: ${JSON.stringify(
          e
        )}`
      );
    }
  }
}

// -----------------------------------------------------------------------------
// Internal processors (use _SENT marker to prevent duplicates)
// -----------------------------------------------------------------------------
async function processScheduledNotification(lead, step, attemptNumber) {
  console.debug(
    `[DEBUG] processScheduledNotification: Processing for leadId ${lead.id}, step ${step}, attemptNumber ${attemptNumber}`
  );
  if (await ensureOnce(lead.id, `${step}_SENT`)) {
    console.debug(
      `[DEBUG] processScheduledNotification: Idempotency check passed for ${step}_SENT`
    );
    const copy = getAttemptCopy(step, true);
    await sendEmailAndSMS({
      lead,
      subject: copy.subject,
      smsBody: copy.smsBody,
      skipEmail: false,
      context: {
        attemptNumber,
        outcome: "ANSWERED",
        title: copy.title,
        subtitle: copy.subtitle,
        cta_text: copy.cta_text,
        cta_link: BOOKING_URL,
        bodyText: copy.bodyText,
        closingText: copy.closingText,
      },
    });
    console.debug(
      `[DEBUG] processScheduledNotification: Notification sent for step ${step}`
    );
  } else {
    console.debug(
      `[DEBUG] processScheduledNotification: Idempotency check failed for ${step}_SENT, skipping`
    );
  }
}

async function processQuickScheduledNotification(lead, step, attemptNumber) {
  console.debug(
    `[DEBUG] processQuickScheduledNotification: Processing for leadId ${lead.id}, step ${step}, attemptNumber ${attemptNumber}`
  );
  if (await ensureOnce(lead.id, `${step}_SENT`)) {
    console.debug(
      `[DEBUG] processQuickScheduledNotification: Idempotency check passed for ${step}_SENT`
    );
    const copy = getAttemptCopy(step, true);
    await sendEmailAndSMS({
      lead,
      subject: copy.subject,
      smsBody: copy.smsBody,
      skipEmail: false,
      context: {
        attemptNumber,
        outcome: "ANSWERED",
        title: copy.title,
        subtitle: copy.subtitle,
        cta_text: copy.cta_text,
        cta_link: BOOKING_URL,
        bodyText: copy.bodyText,
        closingText: copy.closingText,
      },
    });
    console.debug(
      `[DEBUG] processQuickScheduledNotification: Notification sent for step ${step}`
    );
  } else {
    console.debug(
      `[DEBUG] processQuickScheduledNotification: Idempotency check failed for ${step}_SENT, skipping`
    );
  }
}

// NEW: NO_ANSWER scheduled processors (not “answered” copy)
async function processNoAnswerScheduledNotification(lead, step, attemptNumber) {
  console.debug(
    `[DEBUG] processNoAnswerScheduledNotification: Processing for leadId ${lead.id}, step ${step}, attemptNumber ${attemptNumber}`
  );
  if (await ensureOnce(lead.id, `${step}_SENT`)) {
    console.debug(
      `[DEBUG] processNoAnswerScheduledNotification: Idempotency check passed for ${step}_SENT`
    );
    const copy = getAttemptCopy(step, false);
    await sendEmailAndSMS({
      lead,
      subject: copy.subject,
      smsBody: copy.smsBody,
      skipEmail: attemptNumber === 3, // mirror your immediate path
      context: {
        attemptNumber,
        outcome: "NO_ANSWER",
        title: copy.title,
        subtitle: copy.subtitle,
        cta_text: copy.cta_text,
        cta_link: BOOKING_URL,
        bodyText: copy.bodyText,
        closingText: copy.closingText,
      },
    });
    console.debug(
      `[DEBUG] processNoAnswerScheduledNotification: Notification sent for step ${step}`
    );
  } else {
    console.debug(
      `[DEBUG] processNoAnswerScheduledNotification: Idempotency check failed for ${step}_SENT, skipping`
    );
  }
}

async function processNoAnswerQuickScheduledNotification(
  lead,
  step,
  attemptNumber
) {
  console.debug(
    `[DEBUG] processNoAnswerQuickScheduledNotification: Processing for leadId ${lead.id}, step ${step}, attemptNumber ${attemptNumber}`
  );
  // identical to the non-quick version; split kept for clarity/logging
  await processNoAnswerScheduledNotification(lead, step, attemptNumber);
  console.debug(
    `[DEBUG] processNoAnswerQuickScheduledNotification: Completed processing for step ${step}`
  );
}
