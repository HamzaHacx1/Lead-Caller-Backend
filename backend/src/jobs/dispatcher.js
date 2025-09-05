import { PrismaClient } from "@prisma/client";
import sanitizeHtml from "sanitize-html";
import moment from "moment-timezone";

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

const prisma = new PrismaClient();

/** Optional: compress time in staging (e.g., TIME_SCALE=60 means 1s = 1m) */
const TIME_SCALE = Number(process.env.TIME_SCALE ?? "1");
const TICK_MS = Math.max(
  250,
  Number(process.env.DISPATCHER_TICK_MS ?? "10000")
); // default 10s for snappy tests

/** Feature flag: turn pre-call messages on/off quickly */
const PRECALL_ENABLED = (process.env.PRECALL_ENABLED ?? "1") === "1";

/** If a lead sits IN_PROGRESS for too long (webhook miss etc), reset it */
const ZOMBIE_MINUTES = Number(process.env.DISPATCHER_ZOMBIE_MINUTES ?? "10");

function scaleDelay(ms) {
  console.debug(
    `[DISPATCHER] scaleDelay: Input ms=${ms}, TIME_SCALE=${TIME_SCALE}`
  );
  const scaled = Math.max(0, Math.floor(ms / TIME_SCALE));
  console.debug(`[DISPATCHER] scaleDelay: Scaled delay=${scaled}ms`);
  return scaled;
}

function insideWindow(date, tz) {
  const m = moment(date).tz(pickTz(tz));
  const dow = m.day(); // 0 Sun..6 Sat
  const h = m.hour();
  const isInside = dow !== 0 && dow !== 6 && h >= START && h < END;
  console.debug(
    `[DISPATCHER] insideWindow: Date=${m.format()}, TZ=${tz}, DOW=${dow}, Hour=${h}, IsInside=${isInside}, Window=${START}:00–${END}:00`
  );
  return isInside;
}

/** One-time guard per attempt: inserts NotificationEvent step=PRECALL_<attemptId> if missing */
async function ensurePrecallOnce(leadId, attemptId) {
  console.debug(
    `[DISPATCHER] ensurePrecallOnce: Checking for leadId=${leadId}, attemptId=${attemptId}`
  );
  try {
    return await prisma.$transaction(async (tx) => {
      const step = `PRECALL_${attemptId}`;
      const exists = await tx.notificationEvent.findFirst({
        where: { leadId, step },
        select: { id: true },
      });
      console.debug(
        `[DISPATCHER] ensurePrecallOnce: Existing notification for step=${step}: ${
          exists ? "found" : "not found"
        }`
      );
      if (exists) return false;
      await tx.notificationEvent.create({
        data: { leadId, step, metadata: { attemptId } },
      });
      console.debug(
        `[DISPATCHER] ensurePrecallOnce: Created notification event for step=${step}`
      );
      return true;
    });
  } catch (e) {
    console.warn(
      `[DISPATCHER] ensurePrecallOnce: Failed for leadId=${leadId}, attemptId=${attemptId}, Error=${e.message}`
    );
    // Race? Treat as already sent to avoid dupes.
    return false;
  }
}

/** Render + send pre-call email + SMS (best-effort; don't throw) */
export async function sendPreCallNudge(lead, attempt) {
  console.debug(
    `[DISPATCHER] sendPreCallNudge: Starting for leadId=${lead.id}, attemptId=${attempt.id}, PRECALL_ENABLED=${PRECALL_ENABLED}`
  );
  if (!PRECALL_ENABLED) {
    console.debug(`[DISPATCHER] sendPreCallNudge: Skipped, precall disabled`);
    return;
  }

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

  // Email
  if (lead.email && /\S+@\S+\.\S+/.test(String(lead.email))) {
    try {
      await sendEmail({ to: safe(lead.email), subject, html });
      console.log(
        `[DISPATCHER:email] Sent for leadId=${lead.id}, attemptId=${attempt.id}, email=${lead.email}`
      );
    } catch (e) {
      console.warn(
        `[DISPATCHER:email] Failed for leadId=${lead.id}, email=${lead.email}, Error=${e.message}`
      );
    }
  } else {
    console.log(
      `[DISPATCHER:email] Skipped for leadId=${lead.id}, Reason=no valid email`
    );
  }

  // SMS
  if (lead.phone && String(lead.phone).replace(/[^\d+]/g, "").length >= 10) {
    try {
      await sendSMS({ to: String(lead.phone).trim(), body: smsBody });
      console.log(
        `[DISPATCHER:sms] Sent for leadId=${lead.id}, attemptId=${attempt.id}, phone=${lead.phone}`
      );
    } catch (e) {
      console.warn(
        `[DISPATCHER:sms] Failed for leadId=${lead.id}, phone=${lead.phone}, Error=${e.message}`
      );
    }
  } else {
    console.log(
      `[DISPATCHER:sms] Skipped for leadId=${lead.id}, Reason=no valid phone`
    );
  }
}

/** Reset zombies: IN_PROGRESS for too long with no newer attempt closing it */
async function resetZombies() {
  console.debug(
    `[DISPATCHER] resetZombies: Starting, ZOMBIE_MINUTES=${ZOMBIE_MINUTES}`
  );
  if (!ZOMBIE_MINUTES) {
    console.debug(`[DISPATCHER] resetZombies: Skipped, ZOMBIE_MINUTES not set`);
    return;
  }
  const cutoff = new Date(Date.now() - ZOMBIE_MINUTES * 60 * 1000);
  console.debug(
    `[DISPATCHER] resetZombies: Cutoff time=${cutoff.toISOString()}`
  );

  const zombies = await prisma.lead.findMany({
    where: {
      status: "IN_PROGRESS",
      lastProcessedAt: { lt: cutoff },
      nextScheduledAt: { lte: new Date() }, // due or overdue
    },
    take: 100,
  });
  console.debug(
    `[DISPATCHER] resetZombies: Found ${zombies.length} zombie leads`
  );

  for (const z of zombies) {
    try {
      await prisma.lead.update({
        where: { id: z.id },
        data: { status: "SCHEDULED" }, // let dispatcher pick it up again
      });
      console.log(
        `[DISPATCHER] resetZombies: Reset leadId=${z.id} to SCHEDULED`
      );
    } catch (e) {
      console.warn(
        `[DISPATCHER] resetZombies: Failed to reset leadId=${z.id}, Error=${e.message}`
      );
    }
  }
}

/**
 * Try to claim one lead for calling.
 * Uses pg_try_advisory_lock on lead.id (BIGINT) to prevent races across instances.
 */
async function claimOneDueLead(limitWindowCheck = true) {
  console.debug(
    `[DISPATCHER] claimOneDueLead: Starting, limitWindowCheck=${limitWindowCheck}`
  );
  // keep batch small to reduce lock contention
  const candidates = await prisma.lead.findMany({
    where: {
      status: "SCHEDULED",
      nextScheduledAt: { lte: new Date() },
      attempts: { gt: 0 }, // has at least attempt #1
    },
    orderBy: [{ nextScheduledAt: "asc" }, { id: "asc" }],
    take: 250,
  });
  console.debug(
    `[DISPATCHER] claimOneDueLead: Found ${
      candidates.length
    } candidate leads: ${JSON.stringify(
      candidates.map((l) => ({
        id: l.id,
        nextScheduledAt: l.nextScheduledAt,
        status: l.status,
        metadata: l.metadata,
      }))
    )}`
  );

  for (const lead of candidates) {
    console.debug(
      `[DISPATCHER] claimOneDueLead: Processing leadId=${
        lead.id
      }, nextScheduledAt=${lead.nextScheduledAt}, timezone=${
        lead.timezone || QUEBEC_TZ
      }, metadata.test=${lead.metadata?.test}`
    );

    // Skip business hours check for test leads (metadata.test: true)
    const isTestLead = lead.metadata?.test === true;
    if (
      limitWindowCheck &&
      !isTestLead &&
      !insideWindow(new Date(), lead.timezone || QUEBEC_TZ)
    ) {
      console.debug(
        `[DISPATCHER] claimOneDueLead: Skipped leadId=${lead.id}, Reason=Outside business hours, isTestLead=${isTestLead}`
      );
      continue;
    }

    // advisory lock per lead.id (session lock; not transaction-scoped)
    const got = await prisma.$queryRaw`
      SELECT pg_try_advisory_lock(${BigInt(lead.id)}) AS ok;
    `;
    if (!got?.[0]?.ok) {
      console.debug(
        `[DISPATCHER] claimOneDueLead: Failed to acquire lock for leadId=${lead.id}`
      );
      continue;
    }
    console.debug(
      `[DISPATCHER] claimOneDueLead: Acquired lock for leadId=${lead.id}`
    );

    try {
      // Re-read lead inside a transaction to confirm state and fetch attempt
      const claimed = await prisma.$transaction(async (tx) => {
        const fresh = await tx.lead.findUnique({ where: { id: lead.id } });
        console.debug(
          `[DISPATCHER] claimOneDueLead: Re-read leadId=${
            lead.id
          }, State=${JSON.stringify(
            fresh
              ? {
                  status: fresh.status,
                  nextScheduledAt: fresh.nextScheduledAt,
                  metadata: fresh.metadata,
                }
              : null
          )}`
        );
        if (!fresh) {
          console.debug(
            `[DISPATCHER] claimOneDueLead: LeadId=${lead.id} not found`
          );
          return null;
        }

        // If someone already moved it out of SCHEDULED (race), bail
        if (
          fresh.status !== "SCHEDULED" ||
          fresh.nextScheduledAt > new Date()
        ) {
          console.debug(
            `[DISPATCHER] claimOneDueLead: Skipped leadId=${lead.id}, Reason=Invalid state or not due, Status=${fresh.status}, nextScheduledAt=${fresh.nextScheduledAt}`
          );
          return null;
        }

        // Fetch the *due* scheduled attempt we’re about to execute
        const attempt = await tx.callAttempt.findFirst({
          where: {
            leadId: fresh.id,
            status: "SCHEDULED",
            scheduledAt: { lte: new Date() },
          },
          orderBy: [
            { attemptNumber: "asc" }, // run the earliest missing one first
            { scheduledAt: "asc" },
          ],
        });
        console.debug(
          `[DISPATCHER] claimOneDueLead: Attempt for leadId=${
            lead.id
          }: ${JSON.stringify(
            attempt
              ? {
                  id: attempt.id,
                  attemptNumber: attempt.attemptNumber,
                  scheduledAt: attempt.scheduledAt,
                }
              : null
          )}`
        );
        if (!attempt) {
          console.debug(
            `[DISPATCHER] claimOneDueLead: No valid attempt found for leadId=${lead.id}`
          );
          return null;
        }

        // Move lead to IN_PROGRESS to block overlaps for this lead
        await tx.lead.update({
          where: { id: fresh.id },
          data: {
            status: "IN_PROGRESS",
            lastProcessedAt: new Date(),
          },
        });
        console.debug(
          `[DISPATCHER] claimOneDueLead: Updated leadId=${lead.id} to IN_PROGRESS`
        );

        return { fresh, attempt };
      });

      if (!claimed) {
        console.debug(
          `[DISPATCHER] claimOneDueLead: LeadId=${lead.id} not claimed, releasing lock`
        );
        await prisma.$queryRaw`SELECT pg_advisory_unlock(${BigInt(lead.id)});`;
        continue;
      }

      const { fresh: lockedLead, attempt } = claimed;
      console.debug(
        `[DISPATCHER] claimOneDueLead: Claimed leadId=${lockedLead.id}, attemptId=${attempt.id}, attemptNumber=${attempt.attemptNumber}`
      );

      // ---- NEW: pre-call nudge (once per attempt) ----
      const allowed = await ensurePrecallOnce(lockedLead.id, attempt.id);
      console.debug(
        `[DISPATCHER] claimOneDueLead: Precall allowed for leadId=${lockedLead.id}, attemptId=${attempt.id}: ${allowed}`
      );
      if (allowed) {
        await sendPreCallNudge(lockedLead, attempt);
      }

      // Place the call (webhook will finalize outcome + schedule next attempt)
      console.debug(
        `[DISPATCHER] claimOneDueLead: Initiating call for leadId=${lockedLead.id}, phone=${lockedLead.phone}, attemptNumber=${attempt.attemptNumber}`
      );
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
      console.debug(
        `[DISPATCHER] claimOneDueLead: Call initiated for leadId=${lockedLead.id}, attemptId=${attempt.id}`
      );

      // Release advisory lock
      await prisma.$queryRaw`SELECT pg_advisory_unlock(${BigInt(lead.id)});`;
      console.debug(
        `[DISPATCHER] claimOneDueLead: Released lock for leadId=${lead.id}`
      );

      // Claimed and triggered exactly one lead this loop
      console.log(
        `[DISPATCHER] Successfully processed leadId=${lead.id}, attemptId=${attempt.id}`
      );
      return true;
    } catch (err) {
      console.error(
        `[DISPATCHER] Error processing leadId=${lead.id}, Error=${err.message}`
      );
      // best-effort unlock
      await prisma.$queryRaw`SELECT pg_advisory_unlock(${BigInt(lead.id)});`;
      console.debug(
        `[DISPATCHER] Released lock after error for leadId=${lead.id}`
      );
    }
  }

  console.debug(`[DISPATCHER] claimOneDueLead: No leads claimed`);
  return false;
}

export async function runDispatcherOnce() {
  console.debug(
    `[DISPATCHER] runDispatcherOnce: Starting at ${new Date().toISOString()}`
  );
  // clean up zombies first so follow-up attempts aren’t skipped
  await resetZombies();

  let madeProgress = false;
  for (let i = 0; i < 12; i++) {
    console.debug(`[DISPATCHER] runDispatcherOnce: Attempt ${i + 1}/12`);
    // Revert to original business hours check, except for test leads
    const ok = await claimOneDueLead(true);
    if (!ok) {
      console.debug(
        `[DISPATCHER] runDispatcherOnce: No more leads to process on attempt ${
          i + 1
        }`
      );
      break;
    }
    madeProgress = true;
    console.debug(
      `[DISPATCHER] runDispatcherOnce: Processed a lead, waiting ${scaleDelay(
        150
      )}ms`
    );
    await new Promise((r) => setTimeout(r, scaleDelay(150)));
  }
  console.debug(
    `[DISPATCHER] runDispatcherOnce: Completed, madeProgress=${madeProgress}`
  );
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
      console.debug(`[DISPATCHER] Tick at ${new Date().toISOString()}`);
      await runDispatcherOnce();
    } catch (e) {
      console.error(`[DISPATCHER] Tick error: ${e.message}`);
    }
  }, TICK_MS);

  return () => {
    console.debug(`[DISPATCHER] Stopping dispatcher`);
    clearInterval(timer);
  }; // stop()
}
