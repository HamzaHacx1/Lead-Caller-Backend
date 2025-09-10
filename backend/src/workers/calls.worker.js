// workers/calls.worker.js
import moment from "moment-timezone";
import { startWorker } from "../lib/redisQueue.js";
import { callOutbound } from "../lib/elevenlabs.js";
import prisma from "../lib/prisma.js";
import { QUEBEC_TZ } from "../lib/quebecTime.js";

const PRECALL_NUDGE_MS = Math.max(
  0,
  Number(process.env.PRECALL_CALL_DELAY_MS ?? 5 * 60 * 1000)
);

// Send pre-call nudge (email + SMS) similar to dispatcher
async function sendPreCallNudge({ lead, attempt }) {
  // Using notifications logic directly to keep templates consistent
  const { sendEmail, sendSMS } = await import("../helpers/notify.js");
  const { renderTemplate: renderHbsFile } = await import("../helpers/renderTemplates.js");
  const SUPPORT_NUMBER = process.env.SUPPORT_NUMBER || "";
  const BOOKING_URL =
    process.env.BOOKING_URL || process.env.DASHBOARD_URL || "https://emploirapide.ca/documents";


  const subject = "Tu veux un job ? Il te reste une seule étape !";
  const smsBody =
    "Salut, c'est Simon d'Emploi Rapide — je viens de t'envoyer un courriel important. Va le voir maintenant.";

  const html = renderHbsFile("no_answer_base.hbs", {
    appName: process.env.APP_NAME || "Emploi Rapide",
    bookingUrl: BOOKING_URL,
    supportNumber: SUPPORT_NUMBER || "",
    lead,
    title: "Tu veux un job ?",
    subtitle: "Il te reste une seule étape 🚀",
    bodyText:
      "<p>Tu viens de remplir notre formulaire pour trouver un emploi rapidement.</p>" +
      "<p><strong>Bonne nouvelle : t'es à 1 clic de finaliser ton inscription.</strong></p>",
    cta_text: "INSCRIPTION ICI",
    cta_link: BOOKING_URL,
    closingText: "",
  });

  if (lead.email && /\S+@\S+\.\S+/.test(String(lead.email))) {
    try { await sendEmail({ to: String(lead.email).trim(), subject, html }); } catch {}
  }
  if (lead.phone && String(lead.phone).replace(/[^\d+]/g, "").length >= 10) {
    try { await sendSMS({ to: String(lead.phone).trim(), body: smsBody }); } catch {}
  }
}

async function ensurePrecallOnce(leadId, attemptId) {
  try {
    return await prisma.$transaction(async (tx) => {
      const step = `PRECALL_${attemptId}`;
      const exists = await tx.notificationEvent.findFirst({
        where: { leadId, step },
        select: { id: true },
      });
      if (exists) return false;
      await tx.notificationEvent.create({ data: { leadId, step, metadata: { attemptId } } });
      return true;
    });
  } catch {
    return false;
  }
}

export function startCallsWorker() {
  const limiterDuration = Math.max(1, Number(process.env.CALL_GAP_MS ?? 180000)); // 3 minutes default
  const worker = startWorker(
    "calls",
    async (job) => {
      const { leadId, attemptId, attemptNumber, callAtUnix } = job.data || {};
      if (!leadId || !attemptId || !attemptNumber || !callAtUnix) {
        throw new Error("Invalid call job data");
      }
      const [lead, attempt] = await Promise.all([
        prisma.lead.findUnique({ where: { id: leadId } }),
        prisma.callAttempt.findUnique({ where: { id: attemptId } }),
      ]);
      if (!lead || !attempt) return;

      // If this attempt is no longer scheduled, or the lead has already ANSWERED, skip entirely
      if (attempt.status !== "SCHEDULED" || lead.status === "ANSWERED") {
        // Best-effort: mark attempt as canceled to avoid rescheduling churn
        try {
          if (attempt.status === "SCHEDULED") {
            await prisma.callAttempt.update({
              where: { id: attemptId },
              data: { status: "CANCELED" },
            });
          }
        } catch {}
        return;
      }

      // 1) Pre-call nudge: exactly once, only for the first attempt (always 5 minutes before call)
      try {
        if (attemptNumber === 1) {
          const ok = await ensurePrecallOnce(lead.id, attemptId);
          if (ok) {
            await sendPreCallNudge({ lead, attempt: { id: attemptId, attemptNumber } });
          }
        }
      } catch {}

      // 2) Wait until planned call time
      const waitMs = Math.max(0, callAtUnix * 1000 - Date.now());
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

      // 3) Place the outbound call (re-check that attempt/lead are still valid)
      try {
        const [freshLead, freshAttempt] = await Promise.all([
          prisma.lead.findUnique({ where: { id: leadId } }),
          prisma.callAttempt.findUnique({ where: { id: attemptId } }),
        ]);
        if (!freshLead || !freshAttempt) return;
        if (freshLead.status === "ANSWERED" || freshAttempt.status !== "SCHEDULED") {
          return;
        }
        await callOutbound({
          to: freshLead.phone,
          lead: {
            id: freshLead.id,
            fullName: freshLead.fullName,
            email: freshLead.email,
            timezone: freshLead.timezone || QUEBEC_TZ,
            scheduledAt: new Date(callAtUnix * 1000),
          },
          attemptNumber,
          variables: {},
          metadata: { source: "calls-queue", callAttemptId: attemptId },
        });
      } catch (e) {
        // swallow; webhook will reflect outcome
      }
    },
    {
      concurrency: 1,
      // Global rate limit: 1 call per duration
      limiter: { max: 1, duration: limiterDuration },
    }
  );
  return worker;
}
