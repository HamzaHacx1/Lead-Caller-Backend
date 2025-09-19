import sanitizeHtml from "sanitize-html";
import moment from "moment-timezone";

import { renderTemplate as renderHbsFile } from "../helpers/renderTemplates.js";
import { getNotificationQueue } from "../lib/redisQueue.js";
import { sendEmail, sendSMS } from "../helpers/notify.js";
import { START, END, pickTz } from "../lib/schedule.js";
import { QUEBEC_TZ } from "../lib/quebecTime.js";
import prisma from "./prisma.js";

const { SUPPORT_NUMBER, APP_NAME = "EmploiRapide" } = process.env;
const FAST_NOTIFY = (process.env.FAST_NOTIFY ?? "1") === "1"; // send immediately for testing
// Configurable delays (ms)
const ANSWERED_DELAY_MS_1 = Number(
  process.env.ANSWERED_DELAY_MS_1 ?? 15 * 60 * 1000
);
const ANSWERED_DELAY_MS_2 = Number(
  process.env.ANSWERED_DELAY_MS_2 ?? 30 * 60 * 1000
);
const NO_ANSWER_DELAY_MS_1 = Number(
  process.env.NO_ANSWER_DELAY_MS_1 ?? 10 * 60 * 1000
);
const NO_ANSWER_DELAY_MS_2 = Number(
  process.env.NO_ANSWER_DELAY_MS_2 ?? 10 * 60 * 1000
);
const NO_ANSWER_DELAY_MS_3 = Number(
  process.env.NO_ANSWER_DELAY_MS_3 ?? 10 * 60 * 1000
);
const BOOKING_URL =
  process.env.BOOKING_URL || "https://emploirapide.ca/documents";

const COPY_RICH_TEXT_OPTIONS = {
  allowedTags: [
    "p",
    "br",
    "strong",
    "b",
    "em",
    "i",
    "ul",
    "ol",
    "li",
    "a",
    "sup",
    "sub",
  ],
  allowedAttributes: {
    a: ["href", "target", "rel"],
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesAppliedToAttributes: ["href"],
  allowProtocolRelative: false,
};

const COPY_PLAIN_TEXT_OPTIONS = {
  allowedTags: [],
  allowedAttributes: {},
};

function sanitizeRichText(value) {
  if (value == null) return undefined;
  return sanitizeHtml(String(value), COPY_RICH_TEXT_OPTIONS);
}

function sanitizePlainText(value) {
  if (value == null) return undefined;
  return sanitizeHtml(String(value), COPY_PLAIN_TEXT_OPTIONS);
}

function sanitizeLink(value) {
  if (value == null) return undefined;
  return String(value).trim();
}

export function sanitizeTemplatePayload(payload = {}) {
  if (!payload || typeof payload !== "object") return {};
  const result = {};
  const richFields = [
    "subject",
    "title",
    "subtitle",
    "bodyText",
    "closingText",
    "cta_text",
  ];

  for (const field of richFields) {
    if (field in payload) {
      const sanitized = sanitizeRichText(payload[field]);
      if (sanitized !== undefined) result[field] = sanitized;
    }
  }

  if ("cta_link" in payload) {
    const link = sanitizeLink(payload.cta_link);
    if (link !== undefined) result.cta_link = link;
  }

  if ("smsBody" in payload) {
    const sms = sanitizePlainText(payload.smsBody);
    if (sms !== undefined) result.smsBody = sms;
  }

  return result;
}

export const NOTIFICATION_TEMPLATE_STEPS = [
  { step: "ANSWERED_15M", isAnswered: true },
  { step: "ANSWERED_30M", isAnswered: true },
  { step: "ANSWERED_24H", isAnswered: true },
  { step: "ANSWERED_48H", isAnswered: true },
  { step: "AFTER_1_NO_ANSWER", isAnswered: false },
  { step: "AFTER_2_NO_ANSWER", isAnswered: false },
  { step: "AFTER_3_NO_ANSWER", isAnswered: false },
  { step: "AFTER_1_NO_ANSWER_QUICK", isAnswered: false },
  { step: "AFTER_2_NO_ANSWER_QUICK", isAnswered: false },
  { step: "AFTER_3_NO_ANSWER_QUICK", isAnswered: false },
];

const NOTIFICATION_TEMPLATE_STEP_MAP = new Map(
  NOTIFICATION_TEMPLATE_STEPS.map((entry) => [entry.step, entry])
);

const TEMPLATE_CACHE_TTL_MS = 60 * 1000;
const notificationTemplateCache = new Map();

function getCachedTemplateOverride(step) {
  const cached = notificationTemplateCache.get(step);
  if (!cached) return undefined;
  if (Date.now() - cached.timestamp > TEMPLATE_CACHE_TTL_MS) {
    notificationTemplateCache.delete(step);
    return undefined;
  }
  return cached.value;
}

function setCachedTemplateOverride(step, value) {
  notificationTemplateCache.set(step, {
    value,
    timestamp: Date.now(),
  });
}

export function invalidateNotificationTemplateCache(step) {
  if (!step) {
    notificationTemplateCache.clear();
  } else {
    notificationTemplateCache.delete(step);
  }
}

export function primeNotificationTemplateCache(step, payload) {
  if (!step) return;
  const sanitized = sanitizeTemplatePayload(payload || {});
  setCachedTemplateOverride(step, sanitized);
}

async function getTemplateOverride(step) {
  const cached = getCachedTemplateOverride(step);
  if (cached !== undefined) return cached;
  try {
    const template = await prisma.notificationTemplate.findUnique({
      where: { step },
    });
    if (!template) {
      setCachedTemplateOverride(step, null);
      return null;
    }
    const sanitized = sanitizeTemplatePayload(template.data || {});
    setCachedTemplateOverride(step, sanitized);
    return sanitized;
  } catch (error) {
    console.warn(
      `[NOTIFY] getTemplateOverride failed for step ${step}: ${error?.message}`
    );
    setCachedTemplateOverride(step, null);
    return null;
  }
}

function mergeCopy(base = {}, override = {}) {
  if (!override || Object.keys(override).length === 0) return base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

export async function getNotificationCopy(step, options = {}) {
  const meta = NOTIFICATION_TEMPLATE_STEP_MAP.get(step);
  const isAnswered =
    options.isAnswered ?? options.isAnsweredOverride ?? meta?.isAnswered ?? false;
  const base = getAttemptCopy(step, isAnswered);
  const override = await getTemplateOverride(step);
  if (!override) return base;
  return mergeCopy(base, override);
}

export function getDefaultNotificationCopy(step, options = {}) {
  const meta = NOTIFICATION_TEMPLATE_STEP_MAP.get(step);
  const isAnswered =
    options.isAnswered ?? options.isAnsweredOverride ?? meta?.isAnswered ?? false;
  return getAttemptCopy(step, isAnswered);
}

// Robust test-lead detection (boolean/number/string truthy)
function isTestLead(lead) {
  try {
    const m = lead?.metadata || {};
    const isTruthy = (v) =>
      v === true || v === 1 || v === "1" || String(v).toLowerCase() === "true";
    return (
      isTruthy(m.test) || isTruthy(m.testMode) || isTruthy(m.call_now_test)
    );
  } catch (_) {
    return false;
  }
}

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
// Cancellation helpers when outcome changes
// -----------------------------------------------------------------------------
function stepsForType(type) {
  if (type === "ANSWERED") {
    return [
      "ANSWERED_IMMEDIATE",
      "ANSWERED_24H",
      "ANSWERED_48H",
      "ANSWERED_15M",
      "ANSWERED_30M",
      "ANSWERED_1_SMS_ONLY",
    ];
  }
  if (type === "NO_ANSWER") {
    return [
      "AFTER_1_NO_ANSWER",
      "AFTER_2_NO_ANSWER",
      "AFTER_3_NO_ANSWER",
      "AFTER_1_NO_ANSWER_QUICK",
      "AFTER_2_NO_ANSWER_QUICK",
      "AFTER_3_NO_ANSWER_QUICK",
    ];
  }
  return [];
}

// Cancel all pending NO_ANSWER events from older attempts (e.g., after attempt 2
// we don't want attempt 1's follow-ups firing). Cancels both normal and QUICK.
async function cancelOlderNoAnswerEvents(leadId, attemptNumber) {
  try {
    if (!leadId || !Number.isFinite(attemptNumber) || attemptNumber <= 1) return;
    const now = new Date();

    // Build step names for attempts < attemptNumber
    const olderSteps = [];
    for (let i = 1; i < attemptNumber; i++) {
      olderSteps.push(`AFTER_${i}_NO_ANSWER`);
      olderSteps.push(`AFTER_${i}_NO_ANSWER_QUICK`);
    }
    if (!olderSteps.length) return;

    const del = await prisma.notificationEvent.deleteMany({
      where: {
        leadId,
        step: { in: olderSteps },
        scheduledAt: { gte: now },
      },
    });
    if (del?.count) {
      console.log("[NOTIFY] canceled older no_answer events", {
        leadId,
        attemptNumber,
        count: del.count,
      });
    }

    // Best-effort: also remove pending BullMQ jobs by id
    try {
      const queue = getNotificationQueue();
      for (const step of olderSteps) {
        const jobId = `lead:${leadId}:step:${step}`;
        try {
          const job = await queue.getJob(jobId);
          if (job) {
            await job.remove();
            console.log("[NOTIFY] removed queued job (older)", {
              leadId,
              step,
            });
          }
        } catch (_) {}
      }
    } catch (e) {
      console.warn("[NOTIFY] queue job removal failed (older)", e?.message);
    }
  } catch (e) {
    console.warn("[NOTIFY] cancelOlderNoAnswerEvents failed", e?.message);
  }
}

async function cancelPendingEventsForLead(leadId, type) {
  try {
    const stepList = stepsForType(type);
    if (!leadId || !stepList.length) return;
    const now = new Date();
    const del = await prisma.notificationEvent.deleteMany({
      where: {
        leadId,
        step: { in: stepList },
        scheduledAt: { gte: now },
      },
    });
    if (del?.count) {
      console.log("[NOTIFY] canceled pending events", {
        leadId,
        type,
        count: del.count,
      });
    }

    // Best-effort: also remove pending BullMQ jobs by id
    try {
      const queue = getNotificationQueue();
      for (const step of stepList) {
        const jobId = `lead:${leadId}:step:${step}`;
        try {
          const job = await queue.getJob(jobId);
          if (job) {
            await job.remove();
            console.log("[NOTIFY] removed queued job", { leadId, step });
          }
        } catch (_) {}
      }
    } catch (e) {
      console.warn("[NOTIFY] queue job removal failed", e?.message);
    }
  } catch (e) {
    console.warn("[NOTIFY] cancelPendingEventsForLead failed", e?.message);
  }
}

function stepType(step) {
  if (!step || typeof step !== "string") return null;
  if (
    step.startsWith("AFTER_1_NO_ANSWER") ||
    step.startsWith("AFTER_2_NO_ANSWER") ||
    step.startsWith("AFTER_3_NO_ANSWER")
  ) {
    return "NO_ANSWER";
  }
  if (step.startsWith("ANSWERED_")) return "ANSWERED";
  if (step === "ANSWERED_IMMEDIATE") return "ANSWERED";
  return null;
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
      // Check for existing notification, ignore if older than 1 hour
      const existing = await tx.notificationEvent.findFirst({
        where: {
          leadId,
          step,
          createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) }, // Ignore records older than 1 hour
        },
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
    console.log(
      `[NOTIFY] ensureOnce: Returning false for leadId ${leadId}, step ${step}, reason: ${e.message}`
    );
    return false;
  }
}

// -----------------------------------------------------------------------------
// BullMQ scheduling helper (persist event + enqueue delayed job)
// -----------------------------------------------------------------------------
async function enqueueNotificationEvent({
  leadId,
  step,
  scheduledAt,
  attemptNumber = 1,
}) {
  const when =
    scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt);
  const delay = Math.max(0, when.getTime() - Date.now());

  // Persist a DB row for traceability
  const event = await prisma.notificationEvent.create({
    data: {
      leadId,
      step,
      scheduledAt: when,
      metadata: { attemptNumber },
    },
  });

  // Enqueue BullMQ job
  const queue = getNotificationQueue();
  const jobId = `lead:${leadId}:step:${step}`; // idempotent per lead+step
  console.log("[NOTIFY] enqueue", {
    leadId,
    step,
    attemptNumber,
    scheduledAt: when.toISOString(),
    delay,
    jobId,
  });
  await queue.add(
    "notify-step",
    { leadId, step, attemptNumber, eventId: event.id },
    { delay, jobId }
  );

  return event;
}

// -----------------------------------------------------------------------------
// Small validators
// -----------------------------------------------------------------------------
function isValidEmail(email) {
  const e = (email ?? "").trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;
  return Boolean(e) && emailRegex.test(e) && !e.includes(";");
}

function hasEmail(lead) {
  console.debug(
    `[DEBUG] hasEmail: Checking email for lead: ${JSON.stringify(lead)}`
  );
  const email = (lead?.email ?? "").trim();
  const isValid = isValidEmail(email);
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
    const sanitized = sanitizeRichText(text);
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
          <div>
            <p>Salut 👋</p>
            <p>On a vu que t’as commencé ton inscription…</p>
            <p>Mais ton profil est encore bloqué à l’étape 1 😬</p>
            <p>Il te reste à :</p>
            <ul>
              <li>✅ Ajouter ton CV</li>
              <li>✅ Joindre un spécimen de chèque</li>
            </ul>
            <p>👉 Compléter mon dossier
              <a href="${BOOKING_URL}" target="_blank" rel="noopener noreferrer">${BOOKING_URL}</a>
            </p>
            <p>Pas de stress. Juste une p’tite étape de plus, et tu pourras recevoir des offres.</p>
            <p>On garde ta place au chaud 🔥</p>
            <p><strong>Si tu as déjà rempli ton profil, ignore ce message 😄</strong></p>
          </div>`),
        cta_link: copy.cta_link || BOOKING_URL,
        closingText: sanitize("— L’équipe Emploi Rapide"),
        smsBody: () =>
          sanitize(
            `T’as commencé ton inscription et on t’a renvoyé le courriel. Pense à vérifier les spams si jamais et si tu as déjà complété celui-ci ignore notre message 😄`
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
        cta_link: copy.cta_link || BOOKING_URL,
        bodyText: sanitize(`
          <div>
            <p>Salut !!</p>
            <p>Ton inscription est bien commencée… mais sans CV ni spécimen de chèque, on ne peut pas avancer.</p>
            <p>C’est comme vouloir passer une entrevue sans se présenter 😅</p>
            <p>👉 Compléter mon dossier
              <a href="${BOOKING_URL}" target="_blank" rel="noopener noreferrer">${BOOKING_URL}</a>
            </p>
            <p>Sinon, ton compte va rester en veille. Tu pourras toujours revenir plus tard, mais tu vas manquer des opportunités maintenant.</p>
            <p>On est prêts quand toi tu l’es 💼</p>
          </div>
        `),
        closingText: sanitize("— Emploi Rapide"),
        smsBody: () =>
          sanitize(
            `Dernier rappel : on t’a écrit pour finaliser ton profil. Jette un œil dans ta boîte courriel (et dans les indésirables aussi et ignore si c'est fait !).`
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
      // Test flow 5 minutes after call — same copy as 24h
      const copy = {
        subject: sanitize("T’as ton CV à portée de main ?"),
        title: sanitize("On t’attend encore"),
        cta_text: sanitize("👉 Compléter mon dossier"),
        bodyText: sanitize(`
          <div>
            <p>Salut 👋</p>
            <p>On a vu que t’as commencé ton inscription…</p>
            <p>Mais ton profil est encore bloqué à l’étape 1 😬</p>
            <p>Il te reste à :</p>
            <ul>
              <li>✅ Ajouter ton CV</li>
              <li>✅ Joindre un spécimen de chèque</li>
            </ul>
            <p>👉 Compléter mon dossier
              <a href="${BOOKING_URL}" target="_blank" rel="noopener noreferrer">${BOOKING_URL}</a>
            </p>
            <p>Pas de stress. Juste une p’tite étape de plus, et tu pourras recevoir des offres.</p>
            <p>On garde ta place au chaud 🔥</p>
            <p><strong>Si tu as déjà rempli ton profil, ignore ce message 😄</strong></p>
          </div>
        `),
        cta_link: copy.cta_link || BOOKING_URL,
        closingText: sanitize("— L’équipe Emploi Rapide"),
        smsBody: () =>
          sanitize(
            `T’as commencé ton inscription et on t’a renvoyé le courriel. Pense à vérifier les spams si jamais et si tu as déjà complété celui-ci ignore notre message 😄`
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
      // Test flow 10 minutes after call — same copy as 48h
      const copy = {
        subject: sanitize(
          "On peut pas t’aider tant que ton profil est en pause"
        ),
        title: sanitize("Dernier rappel !"),
        cta_text: sanitize("👉 Compléter mon dossier"),
        cta_link: copy.cta_link || BOOKING_URL,
        bodyText: sanitize(`
          <p>Salut !!</p>
          <p>Ton inscription est bien commencée… mais sans CV ni spécimen de chèque, on ne peut pas avancer.</p>
          <p>C’est comme vouloir passer une entrevue sans se présenter 😅</p>
          <p>👉 Compléter mon dossier (${BOOKING_URL})</p>
          <p>Sinon, ton compte va rester en veille. Tu pourras toujours revenir plus tard, mais tu vas manquer des opportunités maintenant.</p>
          <p>On est prêts quand toi tu l’es 💼</p>`),
        closingText: sanitize("— Emploi Rapide"),
        smsBody: () =>
          sanitize(
            `Dernier rappel : on t’a écrit pour finaliser ton profil. Jette un œil dans ta boîte courriel (et dans les indésirables aussi et ignore si c'est fait !).`
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
  // First follow-up (attempt 1): explicit copy for both normal and quick steps
  if (step === "AFTER_1_NO_ANSWER" || step === "AFTER_1_NO_ANSWER_QUICK") {
    const copy = {
      subject: sanitize("J’ai tenté de t’appeler pour ta job 🚀"),
      title: sanitize("J’ai tenté de t’appeler pour ta job 🚀"),
      cta_text: sanitize("Compléter mon inscription"),
      cta_link: BOOKING_URL,
      bodyText: sanitize(`
        <p>Salut,</p>
        <p>C’est Simon d’Emploi Rapide.</p>
        <p>J’ai essayé de t’appeler aujourd’hui pour avancer dans ta recherche d’emploi, mais je n’ai pas réussi à te joindre.</p>
        <p>Pas de souci — tu peux compléter ton inscription en ligne ici (ça prend 3 minutes) :</p>`),
      closingText: sanitize("À bientôt,"),
      smsBody: (ctx) =>
        sanitize(
          `Salut ${
            ctx?.lead?.firstName || ""
          }, c'est Simon d'${APP_NAME}. J'ai tenté de t'appeler. Tu peux compléter ton inscription ici: ${
            ctx.bookingUrl
          }`
        ),
    };
    return copy;
  }
  if (step === "AFTER_2_NO_ANSWER" || step === "AFTER_2_NO_ANSWER_QUICK") {
    const copy = {
      subject: sanitize("Toujours pas eu de nouvelles 📞"),
      title: sanitize("Toujours pas eu de nouvelles 📞"),
      cta_text: sanitize("Compléter mon inscription"),
      cta_link: BOOKING_URL,
      bodyText: sanitize(`
        <p>Salut,</p>
        <p>Hier, j’ai tenté de te joindre pour ta recherche d’emploi, mais je n’ai pas eu de retour.</p>
        <p>Tu peux gagner du temps en complétant ton inscription directement ici :</p>`),
      closingText: sanitize(
        "On pourra ainsi te proposer des postes plus rapidement. À très vite."
      ),
      smsBody: (ctx) =>
        sanitize(
          `Rebonjour ${
            ctx?.lead?.firstName || ""
          }. Pour avancer plus vite, complète ton dossier ici: ${
            ctx.bookingUrl
          }`
        ),
    };
    return copy;
  }
  if (step === "AFTER_3_NO_ANSWER" || step === "AFTER_3_NO_ANSWER_QUICK") {
    const copy = {
      subject: sanitize("As-tu toujours besoin d’un emploi ?"),
      title: sanitize("As-tu toujours besoin d’un emploi ?"),
      subtitle: sanitize(""),
      cta_link: BOOKING_URL,
      cta_text: sanitize(""),
      bodyText: sanitize(``),
      closingText: sanitize(""),
      smsBody: (ctx) =>
        sanitize(
          `Dernier suivi ${
            ctx?.lead?.firstName || ""
          } — veux-tu toujours de l'aide pour trouver un emploi ? Réponds "Oui" et je te rappelle, ou complète ici: ${
            ctx.bookingUrl
          }`
        ),
    };
    return copy;
  }
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
    smsBody: (ctx) =>
      sanitize(
        `Salut ${
          ctx?.lead?.firstName || ""
        }, c'est Simon d'${APP_NAME}. J'ai tenté de t'appeler. Tu peux compléter ton inscription ici: ${
          ctx.bookingUrl
        }`
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
      smsBody: (ctx) =>
        sanitize(
          `Rebonjour ${
            ctx?.lead?.firstName || ""
          }. Pour avancer plus vite, complète ton dossier ici: ${
            ctx.bookingUrl
          }`
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
      smsBody: (ctx) =>
        sanitize(
          `Dernier suivi ${
            ctx?.lead?.firstName || ""
          } — veux-tu toujours de l'aide pour trouver un emploi ? Réponds "Oui" et je te rappelle, ou complète ici: ${
            ctx.bookingUrl
          }`
        ),
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
      smsBody: (ctx) =>
        sanitize(
          `Petit rappel ${
            ctx?.lead?.firstName || ""
          } : tu peux compléter ton dossier ici: ${ctx.bookingUrl}`
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
      smsBody: (ctx) =>
        sanitize(
          `Dernier suivi ${
            ctx?.lead?.firstName || ""
          } — toujours à la recherche d'un emploi ? Réponds "Oui" et je te rappelle, ou complète ici: ${
            ctx.bookingUrl
          }`
        ),
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
async function sendEmailAndSMS({
  lead,
  subject,
  context,
  smsBody,
  skipEmail,
  toEmailOverride = null,
  toPhoneOverride = null,
}) {
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

  let emailSent = false;
  let smsSent = false;

  // Email
  const toEmail = (toEmailOverride ?? lead?.email ?? "").trim();
  if (!skipEmail && isValidEmail(toEmail)) {
    try {
      console.debug(
        `[DEBUG] sendEmailAndSMS: Rendering email template for leadId ${lead.id}`
      );
      const html = renderHbsFile("no_answer_base.hbs", baseCtx);
      console.debug(
        `[DEBUG] sendEmailAndSMS: Email HTML generated, length: ${html.length}`
      );
      console.log("[NOTIFY:email] sending", {
        leadId: lead.id,
        to: toEmail,
        subject,
      });
      const info = await sendEmail({
        to: toEmail,
        subject,
        html,
      });
      emailSent = true;
      console.log("[NOTIFY:email] sent", {
        leadId: lead.id,
        accepted: info?.accepted,
        rejected: info?.rejected,
        messageId: info?.messageId,
        response: info?.response,
      });
    } catch (e) {
      console.warn("[NOTIFY:email] failed", e?.message);
      console.debug(`[DEBUG] sendEmailAndSMS: Email send failed: ${e.message}`);
    }
  } else {
    console.log("[NOTIFY:email] skipped", {
      leadId: lead?.id,
      reason: skipEmail ? "forced skip" : "no valid email",
    });
    console.debug(
      `[DEBUG] sendEmailAndSMS: Email skipped, reason: ${
        skipEmail ? "forced skip" : "no valid email"
      }`
    );
  }

  // SMS
  const toPhone = (toPhoneOverride ?? lead?.phone ?? "").trim();
  if (toPhone && smsBody) {
    try {
      const to = String(toPhone).trim();
      console.debug(`[DEBUG] sendEmailAndSMS: Preparing SMS for ${to}`);
      const body =
        typeof smsBody === "function" ? smsBody(baseCtx) : String(smsBody);
      console.debug(`[DEBUG] sendEmailAndSMS: SMS body: ${body}`);
      if (body) {
        console.log("[NOTIFY:sms] sending", { leadId: lead.id, to });
        await sendSMS({ to, body });
        smsSent = true;
        console.log("[NOTIFY:sms] sent", { leadId: lead.id });
      }
    } catch (e) {
      console.warn("[NOTIFY:sms] failed", e?.message);
      console.debug(`[DEBUG] sendEmailAndSMS: SMS send failed: ${e.message}`);
    }
  }

  return { emailSent, smsSent };
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
    { step: "ANSWERED_24H", delayMs: FAST_NOTIFY ? 0 : 24 * 60 * 60 * 1000 },
    { step: "ANSWERED_48H", delayMs: FAST_NOTIFY ? 0 : 48 * 60 * 60 * 1000 },
  ];

  for (const p of plans) {
    console.debug(
      `[DEBUG] scheduleDelayedNotifications: Processing plan for step ${p.step}, delay ${p.delayMs}ms`
    );
    const target = now.clone().add(p.delayMs, "milliseconds").toDate();
    console.debug(
      `[DEBUG] scheduleDelayedNotifications: Target time: ${target}`
    );
    const created = await enqueueNotificationEvent({
      leadId: lead.id,
      step: p.step,
      scheduledAt: target, // No window clamping for testing
      attemptNumber: 1,
    });
    console.debug(
      `[DEBUG] scheduleDelayedNotifications: Enqueued notification event: ${JSON.stringify(
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
  const isTest = isTestLead(lead);
  const A1 = isTest
    ? Number(process.env.TEST_ANSWERED_DELAY_MS_1 ?? 90_000)
    : ANSWERED_DELAY_MS_1;
  const A2 = isTest
    ? Number(process.env.TEST_ANSWERED_DELAY_MS_2 ?? 180_000)
    : ANSWERED_DELAY_MS_2;
  const plans = [
    { step: "ANSWERED_15M", delayMs: FAST_NOTIFY ? 0 : A1 },
    { step: "ANSWERED_30M", delayMs: FAST_NOTIFY ? 0 : A2 },
  ];

  for (const p of plans) {
    console.debug(
      `[DEBUG] scheduleQuickNotifications: Processing plan for step ${p.step}, delay ${p.delayMs}ms`
    );
    const target = now.clone().add(p.delayMs, "milliseconds").toDate();
    console.debug(`[DEBUG] scheduleQuickNotifications: Target time: ${target}`);
    // If you want strict business-hours clamping during tests, swap `target` with:
    // const scheduledAt = rollForwardToWindowDate(target, tz, START);
    const created = await enqueueNotificationEvent({
      leadId: lead.id,
      step: p.step,
      scheduledAt: target,
      attemptNumber: 1,
    });
    console.debug(
      `[DEBUG] scheduleQuickNotifications: Enqueued notification event: ${JSON.stringify(
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

  const valid = ["ANSWERED", "NO_ANSWER", "FAILED"];
  if (!valid.includes(outcome)) {
    console.warn(`[NOTIFY] Invalid outcome ${outcome} for lead ${lead.id}`);
    console.debug(
      `[DEBUG] handleQuickAttemptNotifications: Invalid outcome ${outcome}, exiting`
    );
    return;
  }

  if (outcome === "ANSWERED") {
    // Cancel any pending NO_ANSWER follow-ups now that the lead answered
    await cancelPendingEventsForLead(lead.id, "NO_ANSWER");
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
    // Cancel any pending ANSWERED follow-ups since we are in a no-answer/failed path
    if (outcome === "NO_ANSWER" || outcome === "FAILED") {
      await cancelPendingEventsForLead(lead.id, "ANSWERED");
      // Also cancel older no-answer attempts to avoid duplicate cascades
      await cancelOlderNoAnswerEvents(lead.id, attemptNumber);
    }
    const step = `AFTER_${attemptNumber}_NO_ANSWER`;
    console.debug(
      `[DEBUG] handleAttemptNotifications: Processing NO_ANSWER step ${step}`
    );
    if (await ensureOnce(lead.id, `${step}_SCHEDULED`)) {
      console.debug(
        `[DEBUG] handleAttemptNotifications: Idempotency check passed for ${step}_SCHEDULED`
      );
      const tz = pickTz(lead.timezone || QUEBEC_TZ);
      const now = moment().tz(tz);
      const isTest = isTestLead(lead);
      const perAttempt = isTest
        ? [
            Number(process.env.TEST_NO_ANSWER_DELAY_MS_1 ?? 90_000),
            Number(process.env.TEST_NO_ANSWER_DELAY_MS_2 ?? 90_000),
            Number(process.env.TEST_NO_ANSWER_DELAY_MS_3 ?? 90_000),
          ]
        : [NO_ANSWER_DELAY_MS_1, NO_ANSWER_DELAY_MS_2, NO_ANSWER_DELAY_MS_3];
      const delayMs = FAST_NOTIFY
        ? 0
        : perAttempt[Math.max(0, attemptNumber - 1)] ?? perAttempt[0];
      const scheduledAt = now.clone().add(delayMs, "milliseconds").toDate();
      console.debug(
        `[DEBUG] handleAttemptNotifications: Scheduling for ${scheduledAt}, delay: ${delayMs}ms`
      );

      // Enqueue through BullMQ even for immediate (delay 0) to avoid misses
      const created = await enqueueNotificationEvent({
        leadId: lead.id,
        step,
        scheduledAt,
        attemptNumber,
      });
      console.debug(
        `[DEBUG] handleAttemptNotifications: Enqueued notification: ${JSON.stringify(
          created
        )}`
      );
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

  const valid = ["ANSWERED", "NO_ANSWER", "FAILED"]; // Added FAILED
  if (!valid.includes(outcome)) {
    console.warn(`[NOTIFY] Invalid outcome ${outcome} for lead ${lead.id}`);
    console.debug(
      `[DEBUG] handleQuickAttemptNotifications: Invalid outcome ${outcome}, exiting`
    );
    return;
  }

  if (outcome === "ANSWERED") {
    // Cancel any pending NO_ANSWER follow-ups now that the lead answered
    await cancelPendingEventsForLead(lead.id, "NO_ANSWER");
    const tz = pickTz(lead.timezone || QUEBEC_TZ);
    const now = moment().tz(tz);
    const isTest = isTestLead(lead);

    if (isTest) {
      // Test flow: schedule +5m and +10m (immediate is sent at webhook time)
      const steps = [
        { step: "ANSWERED_15M", delayMs: 5 * 60 * 1000 },
        { step: "ANSWERED_30M", delayMs: 10 * 60 * 1000 },
      ];
      for (const p of steps) {
        if (await ensureOnce(lead.id, `${p.step}_SCHEDULED`)) {
          const scheduledAt = now
            .clone()
            .add(p.delayMs, "milliseconds")
            .toDate();
          await enqueueNotificationEvent({
            leadId: lead.id,
            step: p.step,
            scheduledAt,
            attemptNumber,
          });
        }
      }
      return;
    }

    // Production flow: schedule +24h and +48h (immediate is sent at webhook time)
    const steps = [
      { step: "ANSWERED_24H", delayMs: 24 * 60 * 60 * 1000 },
      { step: "ANSWERED_48H", delayMs: 48 * 60 * 60 * 1000 },
    ];
    for (const p of steps) {
      if (await ensureOnce(lead.id, `${p.step}_SCHEDULED`)) {
        const scheduledAt = now.clone().add(p.delayMs, "milliseconds").toDate();
        await enqueueNotificationEvent({
          leadId: lead.id,
          step: p.step,
          scheduledAt,
          attemptNumber,
        });
      }
    }
    return;
  }

  // TESTING: For testing, send NO_ANSWER_QUICK notifications immediately or schedule at 2-min intervals
  if (
    (outcome === "NO_ANSWER" || outcome === "FAILED") &&
    attemptNumber >= 1 &&
    attemptNumber <= 3
  ) {
    // Cancel any pending ANSWERED follow-ups since we are in a no-answer/failed path
    await cancelPendingEventsForLead(lead.id, "ANSWERED");
    // Also cancel older no-answer attempts (normal + quick)
    await cancelOlderNoAnswerEvents(lead.id, attemptNumber);
    const step = `AFTER_${attemptNumber}_NO_ANSWER_QUICK`;
    console.debug(
      `[DEBUG] handleQuickAttemptNotifications: Processing NO_ANSWER_QUICK step ${step}`
    );
    if (await ensureOnce(lead.id, `${step}_SCHEDULED`)) {
      console.debug(
        `[DEBUG] handleQuickAttemptNotifications: Idempotency check passed for ${step}_SCHEDULED`
      );
      const tz = pickTz(lead.timezone || QUEBEC_TZ);
      const now = moment().tz(tz);
      const isTest = isTestLead(lead);
      let delayMs;
      if (isTest) {
        delayMs = attemptNumber === 1 ? 0 : 120_000;
      } else {
        const perAttemptQ = [
          NO_ANSWER_DELAY_MS_1,
          NO_ANSWER_DELAY_MS_2,
          NO_ANSWER_DELAY_MS_3,
        ];
        delayMs = FAST_NOTIFY
          ? 0
          : perAttemptQ[Math.max(0, attemptNumber - 1)] ?? perAttemptQ[0];
      }
      const scheduledAt = now.clone().add(delayMs, "milliseconds").toDate();
      console.debug(
        `[DEBUG] handleQuickAttemptNotifications: Scheduling for ${scheduledAt}, delay: ${delayMs}ms`
      );

      const created = await enqueueNotificationEvent({
        leadId: lead.id,
        step,
        scheduledAt,
        attemptNumber,
      });
      console.debug(
        `[DEBUG] handleQuickAttemptNotifications: Enqueued notification: ${JSON.stringify(
          created
        )}`
      );
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
export async function processScheduledNotifications(limit = 500) {
  // console.debug(
  //   `[DEBUG] processScheduledNotifications: Starting with limit ${limit}`
  // );
  const now = new Date();
  // console.debug(`[DEBUG] processScheduledNotifications: Current time: ${now}`);

  const notifications = await prisma.notificationEvent.findMany({
    where: {
      scheduledAt: { lte: now },
      step: {
        in: [
          // Immediate answer step
          "ANSWERED_IMMEDIATE",
          // ANSWERED series (kept)
          "ANSWERED_24H",
          "ANSWERED_48H",
          "ANSWERED_15M",
          "ANSWERED_30M",
          "ANSWERED_1_SMS_ONLY",
          // NEW: NO_ANSWER scheduled steps
          "AFTER_1_NO_ANSWER",
          "AFTER_2_NO_ANSWER",
          "AFTER_3_NO_ANSWER",
          "AFTER_1_NO_ANSWER_QUICK",
          "AFTER_2_NO_ANSWER_QUICK",
          "AFTER_3_NO_ANSWER_QUICK",
        ],
      },
    },
    include: { lead: true },
    take: limit,
    orderBy: { scheduledAt: "asc" },
  });
  // console.debug(
  //   `[DEBUG] processScheduledNotifications: Found ${notifications.length} notifications`
  // );

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

      // Refresh lead to get most recent status/outcome
      let freshLead = null;
      try {
        freshLead = await prisma.lead.findUnique({ where: { id: n.leadId } });
      } catch (_) {}
      const sType = stepType(n.step);
      const curOutcome =
        freshLead?.lastOutcome || freshLead?.status || n.lead?.lastOutcome || n.lead?.status || null;
      // Skip if this step no longer makes sense with the current outcome
      if (sType === "NO_ANSWER" && curOutcome === "ANSWERED") {
        console.log("[NOTIFY] skip outdated no_answer step", {
          eventId: n.id,
          leadId: n.leadId,
          step: n.step,
          outcome: curOutcome,
        });
        await prisma.notificationEvent.delete({ where: { id: n.id } });
        continue;
      }
      if (sType === "ANSWERED" && curOutcome && curOutcome !== "ANSWERED") {
        console.log("[NOTIFY] skip outdated answered step", {
          eventId: n.id,
          leadId: n.leadId,
          step: n.step,
          outcome: curOutcome,
        });
        await prisma.notificationEvent.delete({ where: { id: n.id } });
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
      } else if (["ANSWERED_1_SMS_ONLY"].includes(n.step)) {
        // SMS-only follow-up after first answered call
        const copy = {
          subject: "",
          smsBody: `Salut 👋\nSuite à ton appel avec notre agent, nous avons créé ton profil temporaire. Pour compléter ton dossier, il ne te reste qu’à joindre tes derniers documents sur notre lien sécurisé ! Vas dans tes courriels tu le retrouveras là.\nPar la suite, ton compte sera créé !`,
        };
        await sendEmailAndSMS({
          lead: n.lead,
          subject: copy.subject,
          smsBody: copy.smsBody,
          skipEmail: true,
          context: { attemptNumber, outcome: "ANSWERED" },
        });
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
// Immediate email for first answered call (uses summary variables if provided)
// -----------------------------------------------------------------------------
export async function sendAnsweredImmediateEmail(lead, vars = {}) {
  console.log("[NOTIFY] answered immediate: preparing", {
    leadId: lead?.id,
    hasEmail: !!lead?.email,
    hasPhone: !!lead?.phone,
  });
  const subject =
    "Salut 👋 Suite à ton appel avec notre agent, nous avons créé ton profil temporaire.";
  const emailFromMeta = vars?.emailFromMeta || vars?.email_from_meta || null;
  const firstNonEmpty = (...vals) => {
    for (const v of vals) {
      if (v != null && String(v).trim() !== "") return String(v);
    }
    return null;
  };
  const safe = (v, dflt) =>
    String(v == null || String(v).trim() === "" ? dflt : v);

  const jobTypes = firstNonEmpty(vars.translated_job_types, vars.job_type);
  const available = firstNonEmpty(vars.available_to_start, vars.availability);
  const salary = firstNonEmpty(
    vars.salary_expectation,
    vars.salary_expectations
  );
  const categories = firstNonEmpty(
    vars.translated_user_categories,
    vars.job_field
  );
  const completionLink = firstNonEmpty(vars.completion_link, BOOKING_URL);

  const ctx = {
    title: "",
    subtitle:
      "Suite à ton appel avec notre agent, nous avons créé ton profil temporaire.",
    cta_text: "👉 Compléter mon dossier",
    cta_link: completionLink || BOOKING_URL,
    bodyText: `
      <p>Salut 👋</p>
      <p>Voici quelques informations résumées :</p>
      <p><strong>Type de poste(s) recherché(s) :</strong><br/>${safe(
        jobTypes,
        "Non spécifié"
      )}</p>
      <p><strong>Disponible pour le travail :</strong><br/>${safe(
        available,
        "Non spécifiée"
      )}</p>
      <p><strong>Attentes salariales :</strong><br/>${safe(
        salary,
        "Non spécifiées"
      )}</p>
      <p><strong>Catégories d’emploi :</strong><br/>${safe(
        categories,
        "Non spécifiées"
      )}</p>
      <p>Pour compléter ton dossier, il ne te reste qu’à joindre tes derniers documents sur notre lien sécurisé !</p>
      <p><strong>👉 Compléter mon dossier</strong> (${safe(
        completionLink,
        BOOKING_URL
      )})</p>
      <p>Par la suite, ton compte sera créé !</p>
      <p>Fais ça maintenant, pendant que c’est frais dans ta tête 😄</p>
    `,
    closingText: "À très vite,\n L’équipe Emploi Rapide 🚀",
  };

  const smsBody = [
    "Salut 👋",
    "Suite à ton appel avec notre agent, nous avons créé ton profil temporaire. Pour compléter ton dossier, il ne te reste qu’à joindre tes derniers documents sur notre lien sécurisé ! Vas dans tes courriels tu le retrouveras là.",
    "Par la suite, ton compte sera créé !",
  ].join("\n");

  const sendRes = await sendEmailAndSMS({
    lead,
    subject,
    context: ctx,
    smsBody,
    skipEmail: false,
    toEmailOverride: isValidEmail(emailFromMeta) ? emailFromMeta : null,
  });
  console.log("[NOTIFY] answered immediate: dispatched", { leadId: lead?.id });

  // Fallback: if SMS didn't go out for any reason, enqueue an immediate SMS-only job
  try {
    if (!sendRes?.smsSent) {
      const ok = await ensureOnce(lead.id, "ANSWERED_1_SMS_ONLY_SCHEDULED");
      if (ok) {
        await enqueueNotificationEvent({
          leadId: lead.id,
          step: "ANSWERED_1_SMS_ONLY",
          scheduledAt: new Date(Date.now() + 15 * 1000),
          attemptNumber: 1,
        });
      }
    }
  } catch (_) {}
}

// Queue an immediate-after-call job so the worker reliably delivers the first SMS+email.
export async function scheduleAnsweredImmediate(lead, vars = {}) {
  if (!lead?.id) return;
  try {
    const ok = await ensureOnce(lead.id, "ANSWERED_IMMEDIATE_SCHEDULED");
    if (!ok) return;
  } catch (_) {}

  const emailOverride = vars?.emailFromMeta || vars?.email_from_meta || null;
  const queue = getNotificationQueue();
  const jobId = `lead:${lead.id}:step:ANSWERED_IMMEDIATE`;
  await queue.add(
    "notify-step",
    {
      leadId: lead.id,
      step: "ANSWERED_IMMEDIATE",
      attemptNumber: 1,
      eventId: null,
      emailOverride,
      phoneOverride: null,
      vars,
    },
    { delay: 0, jobId }
  );
}
// -----------------------------------------------------------------------------
// BullMQ worker entrypoint: run a single scheduled step (idempotent)
// -----------------------------------------------------------------------------
export async function runScheduledNotificationJob({
  leadId,
  step,
  attemptNumber = 1,
  eventId = null,
  emailOverride = null,
  phoneOverride = null,
  vars = {},
}) {
  console.log("[NOTIFY] worker: runScheduledNotificationJob", {
    leadId,
    step,
    attemptNumber,
    eventId,
    emailOverride: emailOverride ? "provided" : null,
  });
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return;

  // Skip if this step no longer matches the current lead status
  try {
    const sType = stepType(step);
    const curOutcome = lead?.lastOutcome || lead?.status || null;
    if (sType === "NO_ANSWER" && curOutcome === "ANSWERED") {
      console.log("[NOTIFY] worker: skipping outdated no_answer step", {
        leadId,
        step,
        outcome: curOutcome,
      });
      if (eventId) {
        try { await prisma.notificationEvent.delete({ where: { id: eventId } }); } catch (_) {}
      }
      return;
    }
    if (sType === "ANSWERED" && curOutcome && curOutcome !== "ANSWERED") {
      console.log("[NOTIFY] worker: skipping outdated answered step", {
        leadId,
        step,
        outcome: curOutcome,
      });
      if (eventId) {
        try { await prisma.notificationEvent.delete({ where: { id: eventId } }); } catch (_) {}
      }
      return;
    }
  } catch (_) {}

  if (step === "ANSWERED_IMMEDIATE") {
    await sendAnsweredImmediateEmail(lead, {
      ...vars,
      emailFromMeta: emailOverride || vars?.emailFromMeta || null,
    });
  } else if (["ANSWERED_24H", "ANSWERED_48H"].includes(step)) {
    await processScheduledNotification(lead, step, attemptNumber);
  } else if (["ANSWERED_15M", "ANSWERED_30M"].includes(step)) {
    await processQuickScheduledNotification(lead, step, attemptNumber);
  } else if (["ANSWERED_1_SMS_ONLY"].includes(step)) {
    // SMS-only follow-up after first answered call
    const copy = {
      subject: "",
      smsBody: [
        "Salut 👋",
        "Suite à ton appel avec notre agent, nous avons créé ton profil temporaire. Pour compléter ton dossier, il ne te reste qu’à joindre tes derniers documents sur notre lien sécurisé ! Vas dans tes courriels tu le retrouveras là.",
        "Par la suite, ton compte sera créé !",
      ].join("\n"),
    };
    await sendEmailAndSMS({
      lead,
      subject: copy.subject,
      smsBody: copy.smsBody,
      skipEmail: true,
      context: { attemptNumber, outcome: "ANSWERED" },
    });
  } else if (
    ["AFTER_1_NO_ANSWER", "AFTER_2_NO_ANSWER", "AFTER_3_NO_ANSWER"].includes(
      step
    )
  ) {
    await processNoAnswerScheduledNotification(lead, step, attemptNumber);
  } else if (
    [
      "AFTER_1_NO_ANSWER_QUICK",
      "AFTER_2_NO_ANSWER_QUICK",
      "AFTER_3_NO_ANSWER_QUICK",
    ].includes(step)
  ) {
    await processNoAnswerQuickScheduledNotification(lead, step, attemptNumber);
  } else {
    return; // Unknown step
  }

  // Best-effort cleanup of DB event row, if referenced
  if (eventId) {
    try {
      await prisma.notificationEvent.delete({ where: { id: eventId } });
    } catch (_) {}
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
    const copy = await getNotificationCopy(step, { isAnswered: true });
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
        cta_link: copy.cta_link || BOOKING_URL,
        bodyText: copy.bodyText,
        closingText: copy.closingText,
      },
    });
    try {
      console.log("[NOTIFY] sent", { leadId: lead.id, step, attemptNumber });
    } catch {}
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
    const copy = await getNotificationCopy(step, { isAnswered: true });
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
        cta_link: copy.cta_link || BOOKING_URL,
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
    const copy = await getNotificationCopy(step, { isAnswered: false });
    await sendEmailAndSMS({
      lead,
      subject: copy.subject,
      smsBody: copy.smsBody,
      // Always skip email on 3rd NO_ANSWER follow-up; send SMS only
      skipEmail: attemptNumber === 3,
      context: {
        attemptNumber,
        outcome: "NO_ANSWER",
        title: copy.title,
        subtitle: copy.subtitle,
        cta_text: copy.cta_text,
        cta_link: copy.cta_link || BOOKING_URL,
        bodyText: copy.bodyText,
        closingText: copy.closingText,
      },
    });
    try {
      console.log("[NOTIFY] sent", { leadId: lead.id, step, attemptNumber });
    } catch {}
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
