// jobs/dispatcher.js
import { PrismaClient } from "@prisma/client";
import moment from "moment-timezone";
import sanitizeHtml from "sanitize-html";
import { sendEmail, sendSMS } from "../helpers/notify.js";
import { START, END, pickTz } from "../lib/schedule.js";
import { callOutbound } from "../lib/elevenlabs.js";
import { QUEBEC_TZ } from "../lib/quebecTime.js";

const APP_NAME = process.env.APP_NAME || "Emploi Rapide";
const SUPPORT_NUMBER = process.env.SUPPORT_NUMBER || "";
const BOOKING_URL =
  process.env.BOOKING_URL ||
  process.env.DASHBOARD_URL ||
  "https://emploirapide.ca/documents";

// ...
const prisma = new PrismaClient();

/** Optional: compress time in staging (e.g., TIME_SCALE=60 means 1s = 1m) */
const TIME_SCALE = Number(process.env.TIME_SCALE ?? "1");
const TICK_MS = Math.max(
  1000,
  Number(process.env.DISPATCHER_TICK_MS ?? "30000")
); // default: 30s

/** Feature flag: turn pre-call messages on/off quickly */
const PRECALL_ENABLED = (process.env.PRECALL_ENABLED ?? "1") === "1";

function scaleDelay(ms) {
  return Math.max(0, Math.floor(ms / TIME_SCALE));
}

function insideWindow(date, tz) {
  const m = moment(date).tz(pickTz(tz));
  const dow = m.day(); // 0 Sun..6 Sat
  const h = m.hour();
  return dow !== 0 && dow !== 6 && h >= START && h < END;
}

/** One-time guard per attempt: inserts NotificationEvent step=PRECALL_<attemptId> if missing */
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
  } catch {
    // If anything races, treat as "not allowed to send again"
    return false;
  }
}

/** Render + send pre-call email + SMS (best-effort; don't throw) */

/** Render + send pre-call email + SMS (best-effort; don't throw) */
export async function sendPreCallNudge(lead, attempt) {
  // === EXACT SMS you provided ===
  const smsBody =
    "Salut, c’est Simon d’Emploi Rapide — je viens de t’envoyer un courriel important 📩 Va le voir dès maintenant.";

  // === EXACT email you provided ===
  const subject = "Tu veux un job ? Il te reste une seule étape !";

  // minimal sanitize helper (protect against weird names)
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

  // Email (best-effort)
  if (lead.email && /\S+@\S+\.\S+/.test(String(lead.email))) {
    try {
      await sendEmail({ to: safe(lead.email), subject, html });
      console.log("[PRECALL:email] sent", {
        leadId: lead.id,
        attemptId: attempt.id,
      });
    } catch (e) {
      console.warn("[PRECALL:email] failed", e?.message);
    }
  } else {
    console.log("[PRECALL:email] skipped (no valid email)", {
      leadId: lead.id,
    });
  }

  // SMS (best-effort)
  if (lead.phone && String(lead.phone).replace(/[^\d+]/g, "").length >= 10) {
    try {
      await sendSMS({ to: String(lead.phone).trim(), body: smsBody });
      console.log("[PRECALL:sms] sent", {
        leadId: lead.id,
        attemptId: attempt.id,
      });
    } catch (e) {
      console.warn("[PRECALL:sms] failed", e?.message);
    }
  } else {
    console.log("[PRECALL:sms] skipped (no valid phone)", { leadId: lead.id });
  }
}

/**
 * Try to claim one lead for calling.
 * Uses pg_try_advisory_lock on lead.id (BIGINT) to prevent races across instances.
 */
async function claimOneDueLead(limitWindowCheck = true) {
  // pick a small batch to reduce contention
  const candidates = await prisma.lead.findMany({
    where: {
      status: "SCHEDULED",
      nextScheduledAt: { lte: new Date() },
      attempts: { gt: 0 }, // must have at least attempt #1 reserved by intake
    },
    orderBy: { nextScheduledAt: "asc" },
    take: 25,
  });

  for (const lead of candidates) {
    // guard against dialing outside window
    if (
      limitWindowCheck &&
      !insideWindow(new Date(), lead.timezone || QUEBEC_TZ)
    ) {
      continue;
    }

    // advisory lock per lead.id (session lock; not transaction-scoped)
    const got = await prisma.$queryRaw`SELECT pg_try_advisory_lock(${BigInt(
      lead.id
    )}) AS ok;`;
    const ok = Boolean(got?.[0]?.ok);
    if (!ok) continue;

    try {
      // Re-read lead inside a transaction to confirm state and fetch attempt
      const claimed = await prisma.$transaction(async (tx) => {
        const fresh = await tx.lead.findUnique({ where: { id: lead.id } });
        if (
          !fresh ||
          fresh.status !== "SCHEDULED" ||
          fresh.nextScheduledAt > new Date()
        ) {
          return null; // stale
        }

        // Move to IN_PROGRESS to block overlaps for this lead
        await tx.lead.update({
          where: { id: lead.id },
          data: { status: "IN_PROGRESS", lastProcessedAt: new Date() },
        });

        // Fetch the scheduled attempt we’re about to execute
        const attempt = await tx.callAttempt.findFirst({
          where: {
            leadId: lead.id,
            status: "SCHEDULED",
            scheduledAt: { lte: new Date() },
          },
          orderBy: [{ attemptNumber: "desc" }, { scheduledAt: "asc" }],
        });

        return { fresh, attempt };
      });

      if (!claimed) {
        // nothing to do; unlock & continue
        await prisma.$queryRaw`SELECT pg_advisory_unlock(${BigInt(lead.id)});`;
        continue;
      }

      const { fresh: lockedLead, attempt } = claimed;

      // No scheduled attempt found (rare if someone edited DB) → push back to next window and release
      if (!attempt) {
        const tz = lockedLead.timezone || QUEBEC_TZ;
        const m = moment().tz(tz);
        let next = m
          .clone()
          .minute(Math.ceil((m.minute() + 1) / 5) * 5)
          .second(0);
        if (!insideWindow(next, tz)) {
          next = m
            .clone()
            .add(1, "day")
            .hour(START)
            .minute(0)
            .second(0)
            .millisecond(0);
          while ([0, 6].includes(next.day())) next = next.add(1, "day");
        }
        await prisma.lead.update({
          where: { id: lockedLead.id },
          data: { status: "SCHEDULED", nextScheduledAt: next.toDate() },
        });
        await prisma.$queryRaw`SELECT pg_advisory_unlock(${BigInt(lead.id)});`;
        continue;
      }

      // ---- NEW: send pre-call nudge (once per attempt) ----
      const allowed = await ensurePrecallOnce(lockedLead.id, attempt.id);
      if (allowed) {
        // fire-and-forget (don’t block outbound), but await here to keep ordering
        await sendPreCallNudge(lockedLead, attempt);
      }

      // Place the call (webhook will finalize outcome + next attempt)
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
        variables: {}, // add any dynamic vars here
        metadata: { source: "dispatcher", callAttemptId: attempt.id },
      });

      // Release advisory lock
      await prisma.$queryRaw`SELECT pg_advisory_unlock(${BigInt(lead.id)});`;

      // Claimed and triggered exactly one lead this loop
      return true;
    } catch (err) {
      console.error("[DISPATCHER] error while claiming lead", lead.id, err);
      // try to unlock in case of error
      await prisma.$queryRaw`SELECT pg_advisory_unlock(${BigInt(lead.id)});`;
    }
  }

  return false;
}

export async function runDispatcherOnce() {
  let madeProgress = false;
  for (let i = 0; i < 10; i++) {
    const ok = await claimOneDueLead(true);
    if (!ok) break;
    madeProgress = true;
    await new Promise((r) => setTimeout(r, scaleDelay(150)));
  }
  return madeProgress;
}

export function startDispatcher() {
  console.log(
    `[DISPATCHER] start: tick=${TICK_MS}ms, TIME_SCALE=${TIME_SCALE}, window=${START}:00–${END}:00, precall=${
      PRECALL_ENABLED ? "on" : "off"
    }`
  );
  const timer = setInterval(async () => {
    try {
      await runDispatcherOnce();
    } catch (e) {
      console.error("[DISPATCHER] tick error", e);
    }
  }, TICK_MS);

  return () => clearInterval(timer); // stop()
}
