import sanitizeHtml from "sanitize-html";
import moment from "moment-timezone";

import { sendEmail, sendSMS } from "../helpers/notify.js";
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

const ZOMBIE_MINUTES = Number(process.env.DISPATCHER_ZOMBIE_MINUTES ?? "10");

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

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.55;color:#0f172a">
      <p>Salut 👋</p>
      <p>Tu viens tout juste de remplir notre formulaire pour trouver un emploi rapidement 🙌</p>
      <p><strong>Bonne nouvelle : t’es à 1 clic de finaliser ton inscription sur notre plateforme.</strong></p>
      <p>👉 Clique ici pour compléter ton profil (3 minutes max) :</p>
      <p style="margin:16px 0">
        <a href="${BOOKING_URL}" target="_blank" rel="noopener"
           style="display:inline-block;background:#111827;color:#ffffff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:600">
          ➡️ INSCRIPTION ICI
        </a>
      </p>
      <p>Tout est fait pour aller vite. Pas besoin de tout réécrire — on s’occupe de tout 💪</p>
      <p>À bientôt !</p>
      ${
        SUPPORT_NUMBER
          ? `<p style="font-size:12px;color:#64748b">Besoin d’aide ? Écris-nous ou appelle ${SUPPORT_NUMBER}.</p>`
          : ""
      }
    </div>
  `;

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

async function resetZombies() {
  if (!ZOMBIE_MINUTES) return;
  const cutoff = new Date(Date.now() - ZOMBIE_MINUTES * 60 * 1000);

  const zombies = await prisma.lead.findMany({
    where: {
      status: "IN_PROGRESS",
      lastProcessedAt: { lt: cutoff },
      nextScheduledAt: { lte: new Date() },
    },
    take: 100,
  });

  for (const z of zombies) {
    try {
      await prisma.lead.update({
        where: { id: z.id },
        data: { status: "SCHEDULED" },
      });
    } catch (e) {}
  }
}

async function claimOneDueLead(limitWindowCheck = true) {
  const candidates = await prisma.lead.findMany({
    where: {
      status: "SCHEDULED",
      nextScheduledAt: { lte: new Date() },
      attempts: { gt: 0 },
    },
    orderBy: [{ nextScheduledAt: "asc" }, { id: "asc" }],
    take: 250,
  });

  for (const lead of candidates) {
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
        const fresh = await tx.lead.findUnique({ where: { id: lead.id } });
        if (!fresh) return null;

        if (
          fresh.status !== "SCHEDULED" ||
          fresh.nextScheduledAt > new Date()
        ) {
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
        if (!attempt) return null;

        await tx.lead.update({
          where: { id: fresh.id },
          data: {
            status: "IN_PROGRESS",
            lastProcessedAt: new Date(),
          },
        });

        return { fresh, attempt };
      });

      if (!claimed) {
        await prisma.$queryRaw`SELECT pg_advisory_unlock(${BigInt(lead.id)});`;
        continue;
      }

      const { fresh: lockedLead, attempt } = claimed;

      const allowed = await ensurePrecallOnce(lockedLead.id, attempt.id);
      if (allowed) {
        await sendPreCallNudge(lockedLead, attempt);
      }

      await callOutbound({
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

      await prisma.$queryRaw`SELECT pg_advisory_unlock(${BigInt(lead.id)});`;

      return true;
    } catch (err) {
      await prisma.$queryRaw`SELECT pg_advisory_unlock(${BigInt(lead.id)});`;
    }
  }

  return false;
}

export async function runDispatcherOnce() {
  await resetZombies();

  let madeProgress = false;
  for (let i = 0; i < 12; i++) {
    const ok = await claimOneDueLead(true);
    if (!ok) break;
    madeProgress = true;
    await new Promise((r) => setTimeout(r, scaleDelay(150)));
  }
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
