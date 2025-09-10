import sanitizeHtml from "sanitize-html";
import moment from "moment-timezone";

import { sendEmail, sendSMS } from "../helpers/notify.js";
import { renderTemplate as renderHbsFile } from "../helpers/renderTemplates.js";
import { START, END, pickTz } from "../lib/schedule.js";
import { callOutbound } from "../lib/elevenlabs.js";
import { QUEBEC_TZ } from "../lib/quebecTime.js";
import prisma from "../lib/prisma.js";

const APP_NAME = process.env.APP_NAME || "Emploi Rapide";
const SUPPORT_NUMBER = process.env.SUPPORT_NUMBER || "";
const BOOKING_URL =
  process.env.BOOKING_URL ||
  process.env.DASHBOARD_URL ||
  "https://emploirapide.ca/documents";

const TIME_SCALE = Number(process.env.TIME_SCALE ?? "1");
const TICK_MS = Math.max(
  250,
  Number(process.env.DISPATCHER_TICK_MS ?? "10000")
);

const PRECALL_ENABLED = (process.env.PRECALL_ENABLED ?? "1") === "1";
// Optional delay between pre-call nudge and dialing (ms)
const PRECALL_CALL_DELAY_MS = Math.max(
  0,
  Number(process.env.PRECALL_CALL_DELAY_MS ?? "300000")
);

// ----------------------------------------------------------------------------
// Lightweight structured logging to avoid confusing, overlapping console output
// ----------------------------------------------------------------------------
let TICK_SEQ = 0;
function logDisp(level, message, data) {
  // Logs are disabled
  return;
  const ts = new Date().toISOString();
  const base = `${ts} [DISPATCHER] [tick=${TICK_SEQ}] ${message}`;
  const line = data ? `${base} ${JSON.stringify(data)}` : base;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function scaleDelay(ms) {
  const scaled = Math.max(0, Math.floor(ms / TIME_SCALE));
  return scaled;
}

function insideWindow(date, tz) {
  const m = moment(date).tz(pickTz(tz));
  const dow = m.day();
  const h = m.hour();
  return dow !== 0 && dow !== 6 && h >= START && h < END;
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
      await tx.notificationEvent.create({
        data: { leadId, step, metadata: { attemptId } },
      });
      return true;
    });
  } catch (e) {
    return false;
  }
}

export async function sendPreCallNudge(lead, attempt) {
  if (!PRECALL_ENABLED) return;

  const smsBody =
    "Salut, c’est Simon d’Emploi Rapide — je viens de t’envoyer un courriel important 📩 Va le voir dès maintenant.";
  const subject = "Tu veux un job ? Il te reste une seule étape !";

  const safe = (s) =>
    sanitizeHtml(String(s || ""), { allowedTags: [], allowedAttributes: {} });

  const html = renderHbsFile("no_answer_base.hbs", {
    appName: APP_NAME,
    bookingUrl: BOOKING_URL,
    supportNumber: SUPPORT_NUMBER || "",
    lead,
    title: "Tu veux un job ?",
    subtitle: "Il te reste une seule étape 🚀",
    bodyText:
      "<p>Tu viens tout juste de remplir notre formulaire pour trouver un emploi rapidement 🙌</p>" +
      "<p><strong>Bonne nouvelle : t’es à 1 clic de finaliser ton inscription sur notre plateforme.</strong></p>",
    cta_text: "➡️ INSCRIPTION ICI",
    cta_link: BOOKING_URL,
    closingText: "À bientôt !",
  });

  if (lead.email && /\S+@\S+\.\S+/.test(String(lead.email))) {
    try {
      await sendEmail({ to: safe(lead.email), subject, html });
    } catch (e) {}
  }

  if (lead.phone && String(lead.phone).replace(/[^\d+]/g, "").length >= 10) {
    try {
      await sendSMS({ to: String(lead.phone).trim(), body: smsBody });
    } catch (e) {}
  }
}

async function claimOneDueLead(limitWindowCheck = true) {
  // Limit work to today (Québec time) to avoid calling old leads
  const startOfTodayQc = moment.tz(QUEBEC_TZ).startOf("day").toDate();

  // Primary path: use lead.nextScheduledAt (today only) as an index-friendly scan
  const candidates = await prisma.lead.findMany({
    where: {
      status: "SCHEDULED",
      nextScheduledAt: { gte: startOfTodayQc, lte: new Date() },
      attempts: { gt: 0 },
    },
    orderBy: [{ nextScheduledAt: "asc" }, { id: "asc" }],
    take: 250,
  });

  // Fallback path: if index field drifted, discover due attempts directly (today only)
  let fallbackAttempts = [];
  if (candidates.length === 0) {
    try {
      fallbackAttempts = await prisma.callAttempt.findMany({
        where: {
          status: "SCHEDULED",
          scheduledAt: { gte: startOfTodayQc, lte: new Date() },
          lead: { status: "SCHEDULED", nextScheduledAt: { lte: new Date() } },
        },
        select: {
          id: true,
          leadId: true,
          attemptNumber: true,
          scheduledAt: true,
        },
        orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
        take: 250,
      });
    } catch (e) {}
    logDisp("info", "No due leads; scanning due attempts", {
      count: fallbackAttempts.length,
    });
  }

  for (const lead of candidates) {
    logDisp("info", "Considering lead", {
      id: lead.id,
      nextScheduledAt: lead.nextScheduledAt,
      attempts: lead.attempts,
      tz: lead.timezone,
      isTest: lead.metadata?.test === true,
    });
    const isTestLead = lead.metadata?.test === true;
    if (
      limitWindowCheck &&
      !isTestLead &&
      !insideWindow(new Date(), lead.timezone || QUEBEC_TZ)
    ) {
      logDisp("info", "Skipping (outside window)", { id: lead.id });
      continue;
    }

    const got = await prisma.$queryRaw`
      SELECT pg_try_advisory_lock(${BigInt(lead.id)}) AS ok;
    `;
    if (!got?.[0]?.ok) continue;

    try {
      const claimed = await prisma.$transaction(async (tx) => {
        const fresh = await tx.lead.findUnique({ where: { id: lead.id } });
        if (!fresh) return null;

        if (
          fresh.status !== "SCHEDULED" ||
          fresh.nextScheduledAt > new Date()
        ) {
          logDisp("info", "Skip inside tx (not due/status)", {
            id: lead.id,
            status: fresh.status,
            nextScheduledAt: fresh.nextScheduledAt,
          });
          return null;
        }

        const attempt = await tx.callAttempt.findFirst({
          where: {
            leadId: fresh.id,
            status: "SCHEDULED",
            scheduledAt: { lte: new Date() },
          },
          orderBy: [{ attemptNumber: "asc" }, { scheduledAt: "asc" }],
        });
        if (!attempt) {
          logDisp("info", "No due attempt for lead", { id: lead.id });
          return null;
        }

        await tx.lead.update({
          where: { id: fresh.id },
          data: {
            status: "IN_PROGRESS",
            lastProcessedAt: new Date(),
          },
        });

        logDisp("info", "Claimed lead", {
          id: fresh.id,
          attemptId: attempt.id,
          attemptNumber: attempt.attemptNumber,
          scheduledAt: attempt.scheduledAt,
        });
        return { fresh, attempt };
      });

      if (!claimed) {
        await prisma.$queryRaw`SELECT pg_advisory_unlock(${BigInt(lead.id)});`;
        continue;
      }

      const { fresh: lockedLead, attempt } = claimed;

      // Pre-call nudge only for the first attempt
      if (PRECALL_ENABLED && attempt.attemptNumber === 1) {
        const allowed = await ensurePrecallOnce(lockedLead.id, attempt.id);
        if (allowed) {
          try {
            logDisp("info", "Precall nudge", {
              id: lockedLead.id,
              attemptId: attempt.id,
              attemptNumber: attempt.attemptNumber,
            });
            await sendPreCallNudge(lockedLead, attempt);
          } catch (e) {
            logDisp("warn", "Precall nudge error", {
              id: lockedLead.id,
              attemptId: attempt.id,
              error: e?.message,
            });
          }
          // Keep the advisory lock during this short delay to avoid races.
          if (PRECALL_CALL_DELAY_MS > 0) {
            logDisp("info", "Precall delay", {
              ms: PRECALL_CALL_DELAY_MS,
              id: lockedLead.id,
              attemptId: attempt.id,
            });
            await new Promise((r) => setTimeout(r, PRECALL_CALL_DELAY_MS));
          }
        }
      }

      try {
        logDisp("info", "Dial start", {
          id: lockedLead.id,
          attemptId: attempt.id,
          attemptNumber: attempt.attemptNumber,
          to: lockedLead.phone,
        });
        const result = await callOutbound({
          to: lockedLead.phone,
          lead: {
            id: lockedLead.id,
            fullName: lockedLead.fullName,
            email: lockedLead.email,
            timezone: lockedLead.timezone,
            scheduledAt: attempt.scheduledAt,
          },
          attemptNumber: attempt.attemptNumber,
          variables: {},
          metadata: { source: "dispatcher", callAttemptId: attempt.id },
        });
        logDisp("info", "Dial dispatched", {
          id: lockedLead.id,
          attemptId: attempt.id,
          conversationId: result?.conversation_id || null,
        });
      } catch (e) {
        logDisp("warn", "Dial error", {
          id: lockedLead.id,
          attemptId: attempt.id,
          error: e?.message,
        });
      }

      await prisma.$queryRaw`SELECT pg_advisory_unlock(${BigInt(lead.id)});`;

      return true;
    } catch (err) {
      logDisp("warn", "Error handling lead", {
        id: lead.id,
        error: err?.message,
      });
      await prisma.$queryRaw`SELECT pg_advisory_unlock(${BigInt(lead.id)});`;
    }
  }

  // Fallback sweep using due attempts → lead
  for (const a of fallbackAttempts) {
    try {
      const lead = await prisma.lead.findUnique({ where: { id: a.leadId } });
      if (!lead) continue;

      logDisp("info", "[FALLBACK] Considering lead/attempt", {
        id: lead.id,
        attemptId: a.id,
        attemptNumber: a.attemptNumber,
        scheduledAt: a.scheduledAt,
        status: lead.status,
        nextScheduledAt: lead.nextScheduledAt,
      });

      const isTestLead = lead.metadata?.test === true;
      if (
        limitWindowCheck &&
        !isTestLead &&
        !insideWindow(new Date(), lead.timezone || QUEBEC_TZ)
      ) {
        continue;
      }

      const got = await prisma.$queryRaw`
        SELECT pg_try_advisory_lock(${BigInt(lead.id)}) AS ok;
      `;
      if (!got?.[0]?.ok) continue;

      try {
        const claimed = await prisma.$transaction(async (tx) => {
          const freshLead = await tx.lead.findUnique({
            where: { id: lead.id },
          });
          if (!freshLead || freshLead.status !== "SCHEDULED") return null;

          const attempt = await tx.callAttempt.findFirst({
            where: {
              id: a.id,
              leadId: freshLead.id,
              status: "SCHEDULED",
              scheduledAt: { lte: new Date() },
            },
          });
          if (!attempt) return null;

          await tx.lead.update({
            where: { id: freshLead.id },
            data: { status: "IN_PROGRESS", lastProcessedAt: new Date() },
          });

          return { freshLead, attempt };
        });

        if (!claimed) {
          await prisma.$queryRaw`SELECT pg_advisory_unlock(${BigInt(
            lead.id
          )});`;
          continue;
        }

        const { freshLead, attempt } = claimed;

        if (PRECALL_ENABLED && attempt.attemptNumber === 1) {
          const allowed = await ensurePrecallOnce(freshLead.id, attempt.id);
          if (allowed) {
            try {
              logDisp("info", "Precall nudge", {
                id: freshLead.id,
                attemptId: attempt.id,
                attemptNumber: attempt.attemptNumber,
              });
              await sendPreCallNudge(freshLead, attempt);
            } catch (e) {
              logDisp("warn", "Precall nudge error", {
                id: freshLead.id,
                attemptId: attempt.id,
                error: e?.message,
              });
            }
            if (PRECALL_CALL_DELAY_MS > 0) {
              logDisp("info", "Precall delay", {
                ms: PRECALL_CALL_DELAY_MS,
                id: freshLead.id,
                attemptId: attempt.id,
              });
              await new Promise((r) => setTimeout(r, PRECALL_CALL_DELAY_MS));
            }
          }
        }

        await callOutbound({
          to: freshLead.phone,
          lead: {
            id: freshLead.id,
            fullName: freshLead.fullName,
            email: freshLead.email,
            timezone: freshLead.timezone,
            scheduledAt: attempt.scheduledAt,
          },
          attemptNumber: attempt.attemptNumber,
          variables: {},
          metadata: { source: "dispatcher", callAttemptId: attempt.id },
        });

        await prisma.$queryRaw`SELECT pg_advisory_unlock(${BigInt(lead.id)});`;
        return true;
      } catch (err) {
        await prisma.$queryRaw`SELECT pg_advisory_unlock(${BigInt(lead.id)});`;
      }
    } catch (e) {}
  }

  return false;
}

export async function runDispatcherOnce() {
  TICK_SEQ += 1;
  logDisp("info", "Tick start", null);
  // First, prioritize any due leads over cleanup work.
  let madeProgress = false;
  for (let i = 0; i < 12; i++) {
    const ok = await claimOneDueLead(true);
    if (!ok) break;
    madeProgress = true;
    await new Promise((r) => setTimeout(r, scaleDelay(150)));
  }

  // Zombie logic disabled for now
  logDisp("info", "Tick end", { madeProgress });
  return madeProgress;
}

export function startDispatcher() {
  const timer = setInterval(async () => {
    try {
      await runDispatcherOnce();
    } catch (e) {}
  }, TICK_MS);

  return () => clearInterval(timer);
}
