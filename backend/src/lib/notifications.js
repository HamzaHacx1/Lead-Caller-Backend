import { PrismaClient } from "@prisma/client";
import sanitizeHtml from "sanitize-html";
import moment from "moment-timezone";

import { renderTemplate as renderHbsFile } from "../helpers/renderTemplates.js";
import { sendEmail, sendSMS } from "../helpers/notify.js";
import { nextInsideWindowUnix } from "../lib/schedule.js";
import { QUEBEC_TZ } from "../lib/quebecTime.js";

const prisma = new PrismaClient();
const { SUPPORT_NUMBER, APP_NAME = "EmploiRapide" } = process.env;
const BOOKING_URL = "https://emploirapide.ca/documents";

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

function hasEmail(lead) {
  const email = (lead?.email ?? "").trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;
  return Boolean(email) && emailRegex.test(email) && !email.includes(";");
}

function hasPhone(lead) {
  const phone = lead?.phone ? String(lead.phone).trim() : "";
  return phone.length >= 6 && !phone.includes(";");
}

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
          </ul></p>
        `),
        cta_link: BOOKING_URL || "",
        closingText: sanitize(
          "Pas de stress. Juste une p’tite étape de plus, et tu pourras recevoir des offres. On garde ta place au chaud 🔥"
        ),
        smsBody: (ctx) =>
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
        cta_link: BOOKING_URL || "",
        bodyText: sanitize(`
          <p>Ton inscription est bien commencée… mais sans CV ni spécimen de chèque, on ne peut pas avancer.
          C’est comme vouloir passer une entrevue sans se présenter 😅</p>
          <p>Sinon, ton compte va rester en veille. Tu pourras toujours revenir plus tard, mais tu vas manquer des opportunités maintenant.</p>
        `),
        closingText: sanitize("On est prêts quand toi tu l’es 💼"),
        smsBody: (ctx) =>
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
          </ul></p>
        `),
        cta_link: BOOKING_URL || "",
        closingText: sanitize(
          "Juste une petite étape et t’es prêt pour des offres ! 🔥"
        ),
        smsBody: (ctx) =>
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
        cta_link: BOOKING_URL || "",
        bodyText: sanitize(`
          <p>Ton inscription est en cours, mais sans CV ni spécimen de chèque, on ne peut pas avancer.</p>
          <p>Finalise vite pour ne pas rater des opportunités !</p>
        `),
        closingText: sanitize("On t’attend 💼"),
        smsBody: (ctx) =>
          sanitize(
            `Rappel : finalise ton profil ! Vérifie ton courriel (et les spams).`
          ),
      };
    }
  }

  const defaultCopy = {
    subject: sanitize("J’ai tenté de t’appeler pour ta job 🚀"),
    title: sanitize("J’ai tenté de t’appeler pour ta job 🚀"),
    cta_text: sanitize("➡️ Compléter mon inscription"),
    cta_link: BOOKING_URL || "",
    bodyText: sanitize(`
      <p>Salut,</p>
      <p><strong>J’ai essayé de t’appeler aujourd’hui</strong> pour avancer dans ta recherche d’emploi, mais je n’ai pas réussi à te joindre.</p>
      <p>Pas de souci — tu peux compléter ton inscription en ligne (3 minutes) :</p>
    `),
    closingText: sanitize("À bientôt !"),
    smsBody: (ctx) =>
      sanitize(
        `Simon d’${APP_NAME} — J’ai tenté de t’appeler pour ta recherche d’emploi. Rappelle moi !`
      ),
  };

  if (step === "AFTER_2_NO_ANSWER") {
    return {
      subject: sanitize("Toujours pas eu de nouvelles 📞"),
      title: sanitize("Toujours pas eu de nouvelles 📞"),
      cta_text: sanitize("Compléter mon inscription"),
      cta_link: BOOKING_URL || "",
      bodyText: sanitize(`
        <p>Tu peux gagner du temps en complétant ton inscription directement ici :</p>
      `),
      closingText: sanitize(
        "On pourra ainsi te proposer des postes plus rapidement. À très vite !"
      ),
      smsBody: (ctx) =>
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
      cta_link: BOOKING_URL || "",
      cta_text: sanitize("➡️ DÉMARRER MA CANDIDATURE"),
      bodyText: sanitize(`
        <p>C’est la 3<sup>e</sup> fois qu’on essaye de t’appeler sans succès.</p>
        <p>Si tu veux toujours un job rapidement, il te suffit de compléter ton profil :</p>
      `),
      closingText: sanitize("Merci et à bientôt !"),
      smsBody: (ctx) => sanitize(`As-tu toujours besoin d’un emploi ?`),
    };
  }

  if (step === "AFTER_2_NO_ANSWER_QUICK") {
    return {
      subject: sanitize("Toujours pas de nouvelles 📞"),
      title: sanitize("Toujours pas de nouvelles 📞"),
      cta_text: sanitize("Compléter mon inscription"),
      cta_link: BOOKING_URL || "",
      bodyText: sanitize(`
        <p>Complète ton inscription ici pour avancer :</p>
      `),
      closingText: sanitize(
        "On peut te proposer des postes rapidement. À tout de suite !"
      ),
      smsBody: (ctx) =>
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
      cta_link: BOOKING_URL || "",
      cta_text: sanitize("➡️ DÉMARRER MA CANDIDATURE"),
      bodyText: sanitize(`
        <p>3<sup>e</sup> tentative d’appel sans réponse.</p>
        <p>Complète ton profil pour avancer :</p>
      `),
      closingText: sanitize("Merci et à bientôt !"),
      smsBody: (ctx) => sanitize(`Toujours à la recherche d’un emploi ?`),
    };
  }

  return defaultCopy;
}

async function sendEmailAndSMS({ lead, subject, context, smsBody, skipEmail }) {
  const baseCtx = {
    appName: APP_NAME,
    bookingUrl: BOOKING_URL || "",
    supportNumber: SUPPORT_NUMBER || "",
    lead,
    ...context,
  };
  console.log("[NOTIFY] sendEmailAndSMS", {
    leadId: lead?.id,
    hasEmail: hasEmail(lead),
    skipEmail,
    email: lead?.email || null,
  });

  if (!skipEmail && hasEmail(lead)) {
    try {
      const html = renderHbsFile("no_answer_base.hbs", baseCtx);
      await sendEmail({ to: String(lead.email).trim(), subject, html });
      console.log("[NOTIFY:email] sent", { leadId: lead.id });
    } catch (e) {
      console.warn("[NOTIFY:email] failed", e?.message);
    }
  } else if (skipEmail) {
    console.log("[NOTIFY:email] skipped (forced skip)", { leadId: lead?.id });
  } else {
    console.log("[NOTIFY:email] skipped (no email)", { leadId: lead?.id });
  }

  if (hasPhone(lead) && smsBody) {
    try {
      const to = String(lead.phone).trim();
      const body =
        typeof smsBody === "function" ? smsBody(baseCtx) : String(smsBody);
      if (body) {
        await sendSMS({ to, body });
        console.log("[NOTIFY:sms] sent (inline)", { leadId: lead.id });
      }
    } catch (e) {
      console.warn("[NOTIFY:sms] failed", e?.message);
    }
  }
}

async function scheduleDelayedNotifications(lead, attemptNumber) {
  const tz = lead.timezone || QUEBEC_TZ;
  const now = moment().tz(tz);
  const delays = [
    { step: "ANSWERED_24H", delay: 24 * 60 * 60 * 1000, attempt: 1 }, // 24h
    { step: "ANSWERED_48H", delay: 48 * 60 * 60 * 1000, attempt: 1 }, // 48h
  ];

  for (const { step, delay, attempt } of delays) {
    let scheduledAt = moment(now).add(delay, "milliseconds");
    while (
      scheduledAt.day() === 0 ||
      scheduledAt.day() === 6 ||
      !isInsideQuebecWindow(9, 19)
    ) {
      scheduledAt.add(1, "day").hour(9).minute(0).second(0).millisecond(0);
    }
    await prisma.notificationEvent.create({
      data: {
        leadId: lead.id,
        step,
        scheduledAt: scheduledAt.toDate(),
        metadata: { attemptNumber: attempt },
      },
    });
  }
}

async function scheduleQuickNotifications(lead, attemptNumber) {
  const tz = lead.timezone || QUEBEC_TZ;
  const now = moment().tz(tz);
  const delays = [
    { step: "ANSWERED_15M", delay: 15 * 60 * 1000, attempt: 1 }, // 15 min
    { step: "ANSWERED_30M", delay: 30 * 60 * 1000, attempt: 1 }, // 30 min
  ];

  for (const { step, delay, attempt } of delays) {
    let scheduledAt = moment(now).add(delay, "milliseconds");
    while (
      scheduledAt.day() === 0 ||
      scheduledAt.day() === 6 ||
      !isInsideQuebecWindow(9, 19)
    ) {
      scheduledAt.add(1, "day").hour(9).minute(0).second(0).millisecond(0);
    }
    await prisma.notificationEvent.create({
      data: {
        leadId: lead.id,
        step,
        scheduledAt: scheduledAt.toDate(),
        metadata: { attemptNumber: attempt },
      },
    });
  }
}

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
        cta_link: BOOKING_URL || "",
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
        cta_link: BOOKING_URL || "",
        bodyText: copy.bodyText,
        closingText: copy.closingText,
      },
    });
  }
}

export async function handleAttemptNotifications({
  lead,
  attemptNumber,
  outcome,
}) {
  if (!lead?.id) return;
  console.log("[NOTIFY] handleAttempt", {
    leadId: lead?.id,
    attemptNumber,
    outcome,
  });
  const validOutcomes = ["ANSWERED", "NO_ANSWER"];
  if (!validOutcomes.includes(outcome)) {
    console.warn(`[NOTIFY] Invalid outcome ${outcome} for lead ${lead.id}`);
    return;
  }

  if (outcome === "ANSWERED") {
    await scheduleDelayedNotifications(lead, attemptNumber);
    return;
  }

  if (outcome === "NO_ANSWER" && attemptNumber >= 1 && attemptNumber <= 3) {
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
          cta_link: BOOKING_URL || "",
          bodyText: copy.bodyText,
          closingText: copy.closingText,
        },
      });
    }
  }
}

export async function handleQuickAttemptNotifications({
  lead,
  attemptNumber,
  outcome,
}) {
  if (!lead?.id) return;
  console.log("[NOTIFY] handleQuickAttempt", {
    leadId: lead?.id,
    attemptNumber,
    outcome,
  });

  const validOutcomes = ["ANSWERED", "NO_ANSWER"];
  if (!validOutcomes.includes(outcome)) {
    console.warn(`[NOTIFY] Invalid outcome ${outcome} for lead ${lead.id}`);
    return;
  }

  if (outcome === "ANSWERED") {
    await scheduleQuickNotifications(lead, attemptNumber);
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
          cta_link: BOOKING_URL || "",
          bodyText: copy.bodyText,
          closingText: copy.closingText,
        },
      });
    }
  }
}

export async function processScheduledNotifications() {
  const now = new Date();
  const notifications = await prisma.notificationEvent.findMany({
    where: {
      scheduledAt: { lte: now },
      step: {
        in: ["ANSWERED_24H", "ANSWERED_48H", "ANSWERED_15M", "ANSWERED_30M"],
      },
    },
    include: { lead: true },
  });

  for (const notification of notifications) {
    const attemptNumber = notification.metadata?.attemptNumber || 1;
    if (["ANSWERED_24H", "ANSWERED_48H"].includes(notification.step)) {
      await processScheduledNotification(
        notification.lead,
        notification.step,
        attemptNumber
      );
    } else if (["ANSWERED_15M", "ANSWERED_30M"].includes(notification.step)) {
      await processQuickScheduledNotification(
        notification.lead,
        notification.step,
        attemptNumber
      );
    }
    await prisma.notificationEvent
      .delete({ where: { id: notification.id } })
      .catch((e) => {
        console.warn(
          `[NOTIFY] Failed to delete notification ${notification.id}: ${e.message}`
        );
      });
  }
}
