import { PrismaClient } from "@prisma/client";

import { renderTemplate as renderHbsFile } from "../helpers/renderTemplates.js"; // Handlebars renderer
import { sendEmail, sendSMS } from "../helpers/notify.js";

const prisma = new PrismaClient();
const { BOOKING_URL, SUPPORT_NUMBER, APP_NAME = "EmploiRapide" } = process.env;

/** ensure we don't double-send the same step for the same lead */
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

/** per-attempt copy config (subject/title/subtitle/cta/body/closing/sms) */
function getAttemptCopy(attemptNumber) {
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
    // Inline SMS (no template)
    smsBody: (ctx) =>
      `Simon d’Emploi Rapide — J’ai tenté de t’appeler pour ta recherche d’emploi. Rappelle moi !`,
  };

  if (attemptNumber === 2) {
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
        `Simon d’Emploi Rapide ici — je n’ai toujours pas eu ton appel. Peux-tu me rappeler ? 📞`,
    };
  }

  if (attemptNumber === 3) {
    // just SMS note addressed: we still send email if available, but SMS is fully inline (no txt.hbs)
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

  return defaultCopy; // attempt 1 (or any other) fallback
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
    console.log("[NOTIFY:email] skipped (forced skip for attempt 3)", {
      leadId: lead?.id,
    });
  } else {
    console.log("[NOTIFY:email] skipped (no email)", { leadId: lead?.id });
  }

  // SMS (unchanged)
  if (hasPhone(lead)) {
    try {
      const to = String(lead.phone).trim();
      const body =
        typeof smsBody === "function"
          ? smsBody(baseCtx)
          : String(smsBody || "");
      if (body) {
        await sendSMS({ to, body });
        console.log("[NOTIFY:sms] sent (inline)", { leadId: lead.id });
      }
    } catch (e) {
      console.warn("[NOTIFY:sms] failed", e?.message);
    }
  }
}

/** ONLY trigger on NO_ANSWER for attempts 1, 2, 3 */
export async function handleAttemptNotifications({
  lead,
  attemptNumber,
  outcome,
}) {
  if (!lead?.id) return;
  if (outcome !== "NO_ANSWER") return;

  if (attemptNumber >= 1 && attemptNumber <= 3) {
    const step = `AFTER_${attemptNumber}_NO_ANSWER`;
    if (await ensureOnce(lead.id, step)) {
      const copy = getAttemptCopy(attemptNumber);

      await sendEmailAndSMS({
        lead,
        subject: copy.subject,
        smsBody: copy.smsBody,
        skipEmail: attemptNumber === 3, // 👈 skip email on 3rd attempt
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
