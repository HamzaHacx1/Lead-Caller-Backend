import { PrismaClient } from "@prisma/client";

import { renderTemplate as renderHbsFile } from "../helpers/renderTemplates.js";
import { sendEmail, sendSMS } from "../helpers/notify.js";

const prisma = new PrismaClient();
const { BOOKING_URL, SUPPORT_NUMBER, APP_NAME = "EmploiRapide" } = process.env;

/** Ensure we don't double-send the same step for the same lead */
async function ensureOnce(leadId, step) {
  try {
    await prisma.notificationEvent.create({ data: { leadId, step } });
    return true;
  } catch {
    return false;
  }
}

function hasEmail(lead) {
  return !!lead?.email && /\S+@\S+\.\S+/.test(String(lead.email).trim());
}
function hasPhone(lead) {
  return !!lead?.phone && String(lead.phone).trim().length >= 6;
}

/** Per-attempt copy config (subject/title/subtitle/cta/body/closing/sms) */
function getAttemptCopy(step, isAnswered = false) {
  if (isAnswered) {
    if (step === "ANSWERED_24H") {
      return {
        subject: "T’as ton CV à portée de main ?",
        title: "On t’attend encore",
        cta_text: "👉 Compléter mon dossier",
        bodyText: `
          <p>On a vu que t’as commencé ton inscription…</br>
          Mais ton profil est encore bloqué à l’étape 1 😬</br>
          Il te reste à :</br>
          <ul>
            <li>✅ Ajouter ton CV</li>
            <li>✅ Joindre un spécimen de chèque</li>
          </ul></p>
        `,
        closingText:
          "Pas de stress. Juste une p’tite étape de plus, et tu pourras recevoir des offres. On garde ta place au chaud 🔥",
        smsBody: (ctx) =>
          `T’as commencé ton inscription, mais ton profil est incomplet. On t’a renvoyé le courriel. Pense à vérifier les spams si jamais.`,
      };
    }
    if (step === "ANSWERED_48H") {
      return {
        subject: "On peut pas t’aider tant que ton profil est en pause",
        title: "Dernier rappel !",
        cta_text: "👉 Compléter mon dossier",
        bodyText: `
          <p>Ton inscription est bien commencée… mais sans CV ni spécimen de chèque, on ne peut pas avancer.
          C’est comme vouloir passer une entrevue sans se présenter 😅</p>
          <p>Sinon, ton compte va rester en veille. Tu pourras toujours revenir plus tard, mais tu vas manquer des opportunités maintenant.</p>
        `,
        closingText: "On est prêts quand toi tu l’es 💼",
        smsBody: (ctx) =>
          `Dernier rappel : on t’a écrit pour finaliser ton profil. Jette un œil dans ta boîte courriel (et dans les indésirables aussi!).`,
      };
    }
  }

  // NO_ANSWER logic
  const defaultCopy = {
    subject: "J’ai tenté de t’appeler pour ta job 🚀",
    title: "J’ai tenté de t’appeler pour ta job 🚀",
    cta_text: "➡️ Compléter mon inscription",
    bodyText: `
      <p>Salut,</p>
      <p><strong>J’ai essayé de t’appeler aujourd’hui</strong> pour avancer dans ta recherche d’emploi, mais je n’ai pas réussi à te joindre.</p>
      <p>Pas de souci — tu peux compléter ton inscription en ligne (3 minutes) :</p>
    `,
    closingText: "À bientôt !",
    smsBody: (ctx) =>
      `Simon d’${APP_NAME} — J’ai tenté de t’appeler pour ta recherche d’emploi. Rappelle-moi !`,
  };

  if (step === "AFTER_2_NO_ANSWER") {
    return {
      subject: "Toujours pas eu de nouvelles 📞",
      title: "Toujours pas eu de nouvelles 📞",
      cta_text: "Compléter mon inscription",
      bodyText: `
        <p>Tu peux gagner du temps en complétant ton inscription directement ici :</p>
      `,
      closingText:
        "On pourra ainsi te proposer des postes plus rapidement. À très vite !",
      smsBody: (ctx) =>
        `Simon d’${APP_NAME} ici — je n’ai toujours pas eu ton appel. Peux-tu me rappeler ? 📞`,
    };
  }

  if (step === "AFTER_3_NO_ANSWER") {
    return {
      subject: "Dernier suivi — on met en pause si pas de nouvelles",
      title: "Dernière tentative",
      subtitle: "On aimerait vraiment t’aider 🚀",
      cta_text: "➡️ DÉMARRER MA CANDIDATURE",
      bodyText: `
        <p>C’est la 3<sup>e</sup> fois qu’on essaye de t’appeler sans succès.</p>
        <p>Si tu veux toujours un job rapidement, il te suffit de compléter ton profil :</p>
      `,
      closingText: "Merci et à bientôt !",
      smsBody: (ctx) => `As-tu toujours besoin d’un emploi ?`,
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

  // EMAIL
  if (!skipEmail && hasEmail(lead)) {
    try {
      const html = renderHbsFile("no_answer_base.html.hbs", baseCtx);
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

  // SMS
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

/** Schedule delayed notifications */
async function scheduleDelayedNotifications(lead, attemptNumber) {
  const now = new Date();
  const delays = [
    { step: "ANSWERED_24H", delay: 24 * 60 * 60 * 1000, attempt: 1 }, // 24h
    { step: "ANSWERED_48H", delay: 48 * 60 * 60 * 1000, attempt: 1 }, // 48h
  ];

  for (const { step, delay, attempt } of delays) {
    const scheduledAt = new Date(now.getTime() + delay);
    await prisma.notificationEvent.create({
      data: {
        leadId: lead.id,
        step,
        scheduledAt,
        metadata: { attemptNumber: attempt },
      },
    });
  }
}

/** Process scheduled notifications */
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

/** Main handler for attempt notifications */
export async function handleAttemptNotifications({
  lead,
  attemptNumber,
  outcome,
}) {
  if (!lead?.id) return;

  // Handle ANSWERED outcome
  if (outcome === "ANSWERED") {
    // Schedule 24h and 48h notifications
    await scheduleDelayedNotifications(lead, attemptNumber);
    return;
  }

  // Handle NO_ANSWER outcome
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

/** Process scheduled notifications (to be called by a cron job or similar) */
export async function processScheduledNotifications() {
  const now = new Date();
  const notifications = await prisma.notificationEvent.findMany({
    where: {
      scheduledAt: { lte: now },
      step: { in: ["ANSWERED_24H", "ANSWERED_48H"] },
    },
    include: { lead: true },
  });

  for (const notification of notifications) {
    const attemptNumber = notification.metadata?.attemptNumber || 1;
    await processScheduledNotification(
      notification.lead,
      notification.step,
      attemptNumber
    );
    await prisma.notificationEvent.delete({ where: { id: notification.id } });
  }
}
