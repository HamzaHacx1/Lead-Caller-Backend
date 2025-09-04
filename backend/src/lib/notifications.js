// lib/notifications.js (cleaned & window-safe)
import { PrismaClient } from "@prisma/client";
import sanitizeHtml from "sanitize-html";
import moment from "moment-timezone";

import { renderTemplate as renderHbsFile } from "../helpers/renderTemplates.js";
import { sendEmail, sendSMS } from "../helpers/notify.js";
import { START, END, pickTz } from "../lib/schedule.js";
import { QUEBEC_TZ } from "../lib/quebecTime.js";

const prisma = new PrismaClient();
const { SUPPORT_NUMBER, APP_NAME = "EmploiRapide" } = process.env;
const BOOKING_URL =
  process.env.BOOKING_URL || "https://emploirapide.ca/documents";

// -----------------------------------------------------------------------------
// Window helpers (lead's timezone, not hardcoded Québec)
// -----------------------------------------------------------------------------
function isWeekendAt(date, tz) {
  const d = moment(date).tz(tz).day();
  return d === 0 || d === 6;
}

function isInsideWindowAt(date, tz, startHour = START, endHour = END) {
  const m = moment(date).tz(tz);
  const h = m.hour();
  return !isWeekendAt(date, tz) && h >= startHour && h < endHour;
}

/** Roll forward to next valid business instant (start of day if outside). */
function rollForwardToWindowDate(date, tz, startHour = START) {
  let m = moment(date).tz(tz);
  // If weekend → move to next Monday @ startHour
  while (isWeekendAt(m, tz)) m = m.add(1, "day");
  // If before window start → set to startHour today
  if (m.hour() < startHour) {
    m = m.hour(startHour).minute(0).second(0).millisecond(0);
  }
  // If after window end → next business day @ startHour
  if (!isInsideWindowAt(m, tz)) {
    m = m.add(1, "day").hour(startHour).minute(0).second(0).millisecond(0);
    while (isWeekendAt(m, tz)) m = m.add(1, "day");
  }
  return m.toDate();
}

// -----------------------------------------------------------------------------
// Idempotent step marker (prevents double-scheduling/sending)
// -----------------------------------------------------------------------------
async function ensureOnce(leadId, step) {
  try {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.notificationEvent.findFirst({
        where: { leadId, step },
      });
      if (existing) throw new Error("Notification already scheduled");
      await tx.notificationEvent.create({ data: { leadId, step } });
    });
    return true;
  } catch (e) {
    console.warn(
      `[NOTIFY] ensureOnce failed for ${leadId}/${step}: ${e.message}`
    );
    return false;
  }
}

// -----------------------------------------------------------------------------
// Small validators
// -----------------------------------------------------------------------------
function hasEmail(lead) {
  const email = (lead?.email ?? "").trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;
  return Boolean(email) && emailRegex.test(email) && !email.includes(";");
}
function hasPhone(lead) {
  const phone = lead?.phone ? String(lead.phone).trim() : "";
  return phone.length >= 6 && !phone.includes(";");
}

// -----------------------------------------------------------------------------
// Copy
// -----------------------------------------------------------------------------
function getAttemptCopy(step, isAnswered = false) {
  const sanitize = (text) =>
    sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} });

  if (isAnswered) {
    if (step === "ANSWERED_24H") {
      return {
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
    }
    if (step === "ANSWERED_48H") {
      return {
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
    }
    if (step === "ANSWERED_15M") {
      return {
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
    }
    if (step === "ANSWERED_30M") {
      return {
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
    return {
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
  }
  if (step === "AFTER_3_NO_ANSWER") {
    return {
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
  }
  if (step === "AFTER_2_NO_ANSWER_QUICK") {
    return {
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
  }
  if (step === "AFTER_3_NO_ANSWER_QUICK") {
    return {
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
  }

  return base;
}

// -----------------------------------------------------------------------------
// Sender
// -----------------------------------------------------------------------------
async function sendEmailAndSMS({ lead, subject, context, smsBody, skipEmail }) {
  const baseCtx = {
    appName: APP_NAME,
    bookingUrl: BOOKING_URL,
    supportNumber: SUPPORT_NUMBER || "",
    lead,
    ...context,
  };

  // Email
  if (!skipEmail && hasEmail(lead)) {
    try {
      const html = renderHbsFile("no_answer_base.hbs", baseCtx);
      await sendEmail({ to: String(lead.email).trim(), subject, html });
      console.log("[NOTIFY:email] sent", { leadId: lead.id });
    } catch (e) {
      console.warn("[NOTIFY:email] failed", e?.message);
    }
  } else {
    console.log("[NOTIFY:email] skipped", {
      leadId: lead?.id,
      reason: skipEmail ? "forced skip" : "no email",
    });
  }

  // SMS
  if (hasPhone(lead) && smsBody) {
    try {
      const to = String(lead.phone).trim();
      const body =
        typeof smsBody === "function" ? smsBody(baseCtx) : String(smsBody);
      if (body) {
        await sendSMS({ to, body });
        console.log("[NOTIFY:sms] sent", { leadId: lead.id });
      }
    } catch (e) {
      console.warn("[NOTIFY:sms] failed", e?.message);
    }
  }
}

// -----------------------------------------------------------------------------
// Scheduling (correct tz + window, no hardcoded Québec checks)
// -----------------------------------------------------------------------------
async function scheduleDelayedNotifications(lead) {
  const tz = pickTz(lead.timezone || QUEBEC_TZ);
  const now = moment().tz(tz);

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
}

async function scheduleQuickNotifications(lead) {
  const tz = pickTz(lead.timezone || QUEBEC_TZ);
  const now = moment().tz(tz);

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
}

// -----------------------------------------------------------------------------
// Public APIs used by webhook
// -----------------------------------------------------------------------------
export async function handleAttemptNotifications({
  lead,
  attemptNumber,
  outcome,
}) {
  if (!lead?.id) return;
  console.log("[NOTIFY] handleAttempt", {
    leadId: lead.id,
    attemptNumber,
    outcome,
  });

  const valid = ["ANSWERED", "NO_ANSWER"];
  if (!valid.includes(outcome)) {
    console.warn(`[NOTIFY] Invalid outcome ${outcome} for lead ${lead.id}`);
    return;
  }

  if (outcome === "ANSWERED") {
    // long-tail nudges to finish profile
    await scheduleDelayedNotifications(lead);
    return;
  }

  // NO_ANSWER sequence (1..3)
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
}

// Same as above but the “quick” variant (15m/30m) after a positive/engaged signal.
export async function handleQuickAttemptNotifications({
  lead,
  attemptNumber,
  outcome,
}) {
  if (!lead?.id) return;
  console.log("[NOTIFY] handleQuickAttempt", {
    leadId: lead.id,
    attemptNumber,
    outcome,
  });

  const valid = ["ANSWERED", "NO_ANSWER"];
  if (!valid.includes(outcome)) {
    console.warn(`[NOTIFY] Invalid outcome ${outcome} for lead ${lead.id}`);
    return;
  }

  if (outcome === "ANSWERED") {
    await scheduleQuickNotifications(lead);
    return;
  }

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
}

// -----------------------------------------------------------------------------
// Worker to process due notifications (safe across multiple instances)
// -----------------------------------------------------------------------------
export async function processScheduledNotifications(limit = 200) {
  const now = new Date();

  // Pull a reasonable batch
  const notifications = await prisma.notificationEvent.findMany({
    where: {
      scheduledAt: { lte: now },
      step: {
        in: ["ANSWERED_24H", "ANSWERED_48H", "ANSWERED_15M", "ANSWERED_30M"],
      },
    },
    include: { lead: true },
    take: limit,
    orderBy: { scheduledAt: "asc" },
  });

  for (const n of notifications) {
    try {
      // advisory tx lock on this notification id (prevents double-send)
      const got =
        await prisma.$queryRaw`SELECT pg_try_advisory_xact_lock(${BigInt(
          n.id
        )}) AS ok;`;
      if (!got?.[0]?.ok) continue;

      const attemptNumber = n.metadata?.attemptNumber || 1;

      if (["ANSWERED_24H", "ANSWERED_48H"].includes(n.step)) {
        await processScheduledNotification(n.lead, n.step, attemptNumber);
      } else if (["ANSWERED_15M", "ANSWERED_30M"].includes(n.step)) {
        await processQuickScheduledNotification(n.lead, n.step, attemptNumber);
      }

      // delete marker row after success
      await prisma.notificationEvent.delete({ where: { id: n.id } });
    } catch (e) {
      console.warn(
        `[NOTIFY] processScheduledNotifications error id=${n.id}: ${e.message}`
      );
      // keep row for retry on next tick
    }
  }
}

// -----------------------------------------------------------------------------
// Internal processors (use _SENT marker to prevent duplicates)
// -----------------------------------------------------------------------------
async function processScheduledNotification(lead, step, attemptNumber) {
  if (await ensureOnce(lead.id, `${step}_SENT`)) {
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
  }
}

async function processQuickScheduledNotification(lead, step, attemptNumber) {
  if (await ensureOnce(lead.id, `${step}_SENT`)) {
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
  }
}
