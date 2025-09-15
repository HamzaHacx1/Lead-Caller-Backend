import moment from "moment-timezone";
import { Router } from "express";
import fetch from "node-fetch";
import crypto from "crypto";

import { nextInsideWindowUnix, START, END, pickTz } from "../lib/schedule.js";
import {
  handleQuickAttemptNotifications,
  processScheduledNotifications,
  scheduleAnsweredImmediate,
} from "../lib/notifications.js";
import { nowIn, QUEBEC_TZ } from "../lib/quebecTime.js";
import prisma from "../lib/prisma.js";
import {
  reserveCallSlotAndCreateAttempt,
  enqueueCallForAttempt,
} from "../lib/calls.js";

// ---- dialing policy (tweak for prod/testing) ----
const MAX_ATTEMPTS = 3; // total attempts per lead
const RETRY_GAP_MINUTES = 5; // legacy (unused for production); next-day scheduling is used
const FINAL_STATUSES = new Set([
  "ANSWERED",
  "NO_ANSWER",
  "VOICEMAIL",
  "FAILED",
]);

const r = Router();
const NOTIFY_QUEUE_ENABLED = (process.env.NOTIFY_QUEUE_ENABLED ?? "1") === "1";

/** ---------- HMAC verify ---------- */
function verifyHmac(req) {
  console.debug(`[DEBUG] verifyHmac: Starting HMAC verification`);
  const secret = process.env.EL_WEBHOOK_SECRET || "";
  const header = req.headers["elevenlabs-signature"] || "";
  console.debug(
    `[DEBUG] verifyHmac: Secret: ${
      secret ? "present" : "missing"
    }, Header: ${header}`
  );

  if (!secret || !header || !req.rawBody) {
    console.debug(`[DEBUG] verifyHmac: Missing secret, header, or rawBody`);
    return false;
  }

  const parts = Object.fromEntries(
    header.split(",").map((s) => {
      const [k, ...rest] = s.trim().split("=");
      return [k, rest.join("=")];
    })
  );
  const t = parts.t;
  let v0 = parts.v0 || "";
  console.debug(`[DEBUG] verifyHmac: Parsed header parts - t: ${t}, v0: ${v0}`);

  if (!t || !v0) {
    console.debug(`[DEBUG] verifyHmac: Missing t or v0 in header`);
    return false;
  }

  if (v0.startsWith("sha256=")) v0 = v0.slice("sha256=".length);
  v0 = v0.trim().toLowerCase();
  console.debug(`[DEBUG] verifyHmac: Cleaned v0: ${v0}`);

  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(t, 10);
  console.debug(`[DEBUG] verifyHmac: Current time: ${now}, Timestamp: ${ts}`);

  if (!Number.isFinite(ts) || Math.abs(now - ts) > 30 * 60) {
    console.debug(`[DEBUG] verifyHmac: Timestamp invalid or too old`);
    return false;
  }

  const payload = `${t}.${req.rawBody.toString("utf8")}`;
  console.debug(
    `[DEBUG] verifyHmac: Payload for HMAC: ${payload.slice(0, 50)}...`
  );
  const hex = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  console.debug(`[DEBUG] verifyHmac: Generated HMAC: ${hex}`);

  try {
    const isValid = crypto.timingSafeEqual(
      Buffer.from(hex, "hex"),
      Buffer.from(v0, "hex")
    );
    console.debug(`[DEBUG] verifyHmac: HMAC verification result: ${isValid}`);
    return isValid;
  } catch (e) {
    console.debug(`[DEBUG] verifyHmac: HMAC comparison failed: ${e.message}`);
    return false;
  }
}

/** ---------- utils ---------- */
function normPhone(p) {
  console.debug(`[DEBUG] normPhone: Normalizing phone: ${p}`);
  if (!p) {
    console.debug(`[DEBUG] normPhone: No phone provided, returning null`);
    return null;
  }
  const digits = String(p).replace(/[^\d+]/g, "");
  console.debug(`[DEBUG] normPhone: Stripped to digits: ${digits}`);

  if (digits.startsWith("+")) {
    console.debug(
      `[DEBUG] normPhone: Already has country code, returning ${digits}`
    );
    return digits;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    console.debug(
      `[DEBUG] normPhone: 11-digit US number, adding +: +${digits}`
    );
    return `+${digits}`;
  }
  if (digits.length === 10) {
    console.debug(`[DEBUG] normPhone: 10-digit number, adding +1: +1${digits}`);
    return `+1${digits}`;
  }
  console.debug(`[DEBUG] normPhone: Returning as-is: ${digits}`);
  return digits;
}

function mapOutcomeFromTranscription(data) {
  console.debug(
    `[DEBUG] mapOutcomeFromTranscription: Mapping outcome for data: ${JSON.stringify(
      data
    ).slice(0, 100)}...`
  );
  const cs = data.analysis?.call_successful;
  const success =
    cs === true ||
    String(cs).toLowerCase() === "true" ||
    String(cs).toLowerCase() === "success";
  const term = String(data.metadata?.termination_reason || "").toLowerCase();
  const callDur = Number(
    data.metadata?.call_duration_secs ?? data.call_duration_secs ?? 0
  );
  const LOG_SIGNALS = (process.env.LOG_EL_SIGNALS ?? "0") === "1";
  console.debug(
    `[DEBUG] mapOutcomeFromTranscription: call_successful: ${cs}, termination_reason: ${term}`
  );

  // Build helpers for transcript and features
  const features = data.metadata?.features_usage || {};
  const vmFeatureUsed =
    features?.voicemail_detection?.used === true ||
    String(features?.voicemail_detection?.used || "").toLowerCase() === "true";

  const turns = Array.isArray(data.transcript) ? data.transcript : [];
  const textOf = (m) =>
    String(
      m?.message ?? m?.original_message ?? m?.text ?? m?.transcript ?? m?.content ?? ""
    );
  const speakerOf = (m) =>
    String(m?.speaker ?? m?.role ?? m?.sender ?? m?.source ?? m?.speaker_name ?? "");

  // Detect human/user utterance anywhere in the call
  let humanUtterance = false;
  try {
    humanUtterance = turns.some((m) => {
      const text = textOf(m).trim();
      const speakerRaw = speakerOf(m).toLowerCase();
      const isAgent = m?.is_agent === true || /\b(agent|assistant|ai|bot)\b/.test(speakerRaw);
      const isHuman =
        m?.is_agent === false ||
        speakerRaw === "user" ||
        /\b(user|human|caller|lead|callee|customer|person)\b/.test(speakerRaw);
      return !isAgent && isHuman && text.length >= 2;
    });
  } catch (e) {
    console.debug(
      `[DEBUG] mapOutcomeFromTranscription: transcript check failed: ${e?.message}`
    );
  }

  // Short-call override: treat brief connects with no human speech as NO_ANSWER
  const MIN_ANSWER_SECS = Math.max(1, Number(process.env.MIN_ANSWER_DURATION_SECS ?? 10));
  const DECLINE_TERMS = [
    "declined",
    "rejected",
    "cancelled",
    "canceled",
    "hangup",
    "hung up",
    "user busy",
    "caller hung up",
  ];
  const isDeclineTerm = DECLINE_TERMS.some((p) => term.includes(p));
  if ((callDur > 0 && callDur < MIN_ANSWER_SECS && !humanUtterance) || (isDeclineTerm && !humanUtterance)) {
    console.debug(
      `[DEBUG] mapOutcomeFromTranscription: Short/declined connect (dur=${callDur}s, human=${humanUtterance}) -> NO_ANSWER`
    );
    if (LOG_SIGNALS) {
      console.log("[EL DECISION]", {
        outcome: "NO_ANSWER",
        reason: isDeclineTerm ? "decline_term" : "short_connect",
        call_duration_secs: callDur,
      });
    }
    return "NO_ANSWER";
  }

  // Voicemail detection (early): if any VM signals are present, force NO_ANSWER
  // even if a stray "user" token is picked up by ASR.
  const VM2_PATTERNS = [
    "voicemail",
    "voice mail",
    "answering machine",
    "mailbox",
    "leave a message",
    "after the tone",
    "after the beep",
    "record your message",
    // French
    "boîte vocale",
    "boite vocale",
    "messagerie vocale",
    "laissez un message",
    "après le bip",
    "apres le bip",
    "après le signal sonore",
    "apres le signal sonore",
  ];
  const termHasVm2 = VM2_PATTERNS.some((p) => term.includes(p));
  const transcriptHasVm2 = turns.some((m) =>
    VM2_PATTERNS.some((p) => textOf(m).toLowerCase().includes(p))
  );
  if (vmFeatureUsed || termHasVm2 || transcriptHasVm2) {
    console.debug(
      `[DEBUG] mapOutcomeFromTranscription: Voicemail detected (early) -> NO_ANSWER`
    );
    if (LOG_SIGNALS) {
      console.log("[EL DECISION]", {
        outcome: "NO_ANSWER",
        reason: "vm_signals_early",
      });
    }
    return "NO_ANSWER";
  }

  if (humanUtterance) {
    console.debug(
      `[DEBUG] mapOutcomeFromTranscription: Human utterance found -> ANSWERED`
    );
    if (LOG_SIGNALS) {
      console.log("[EL DECISION]", { outcome: "ANSWERED", reason: "human_utterance" });
    }
    return "ANSWERED";
  }

  // If ElevenLabs marks the call as successful, count as ANSWERED
  if (success) {
    console.debug(`[DEBUG] mapOutcomeFromTranscription: Returning ANSWERED`);
    if (LOG_SIGNALS) {
      console.log("[EL DECISION]", { outcome: "ANSWERED", reason: "success_flag" });
    }
    return "ANSWERED";
  }

  // Direct voicemail detection using termination, features, or transcript hints
  const VM_PATTERNS = [
    "voicemail",
    "answering machine",
    "mailbox",
    "leave a message",
    "after the tone",
    "after the beep",
    "record your message",
    // French
    "boite vocale",
    "boîte vocale",
    "messagerie vocale",
    "laissez un message",
    "apres le bip",
    "après le bip",
    "apres le signal sonore",
    "après le signal sonore",
  ];
  const termHasVm = VM_PATTERNS.some((p) => term.includes(p));
  const transcriptHasVm = turns.some((m) =>
    VM_PATTERNS.some((p) => textOf(m).toLowerCase().includes(p))
  );
  if (LOG_SIGNALS) {
    try {
      console.log("[EL SIGNALS]", {
        conversation_id: data.conversation_id || null,
        call_successful: cs,
        success,
        termination_reason: term,
        call_duration_secs: callDur,
        vmFeatureUsed,
        termHasVm,
        transcriptHasVm,
        humanUtterance,
        turnsCount: turns.length,
        firstTwo: turns.slice(0, 2).map((t) => ({
          role: speakerOf(t) || t?.role || null,
          text: textOf(t).slice(0, 160),
        })),
      });
    } catch {}
  }
  if (vmFeatureUsed || termHasVm || transcriptHasVm) {
    console.debug(
      `[DEBUG] mapOutcomeFromTranscription: Voicemail detected -> NO_ANSWER`
    );
    if (LOG_SIGNALS) {
      console.log("[EL DECISION]", {
        outcome: "NO_ANSWER",
        reason: "vm_signals",
      });
    }
    return "NO_ANSWER";
  }

  // (success already handled above)

  // Simplest rule: if remote party ended the call (user picked up then dropped), count as ANSWERED.
  if (term.includes("remote party") || term.includes("ended by remote")) {
    console.debug(
      `[DEBUG] mapOutcomeFromTranscription: remote party hangup -> ANSWERED (dur=${callDur}s)`
    );
    if (LOG_SIGNALS) {
      console.log("[EL DECISION]", {
        outcome: "ANSWERED",
        reason: "remote_party",
        call_duration_secs: callDur,
      });
    }
    return "ANSWERED";
  }

  if (
    term.includes("no_answer") ||
    term.includes("no-answer") ||
    term.includes("noanswer") ||
    term.includes("silence") ||
    term.includes("busy")
  ) {
    console.debug(`[DEBUG] mapOutcomeFromTranscription: Returning NO_ANSWER`);
    if (LOG_SIGNALS) {
      console.log("[EL DECISION]", {
        outcome: "NO_ANSWER",
        reason: "no_answer_or_silence_or_busy",
      });
    }
    return "NO_ANSWER";
  }
  if (
    term.includes("carrier_error") ||
    term.includes("error") ||
    term.includes("failed")
  ) {
    console.debug(`[DEBUG] mapOutcomeFromTranscription: Returning FAILED`);
    if (LOG_SIGNALS) {
      console.log("[EL DECISION]", { outcome: "FAILED", reason: "error_or_failed" });
    }
    return "FAILED";
  }
  console.debug(`[DEBUG] mapOutcomeFromTranscription: Defaulting to FAILED`);
  if (LOG_SIGNALS) {
    console.log("[EL DECISION]", { outcome: "FAILED", reason: "default_fallback" });
  }
  return "FAILED";
}

/** Robust check for test leads (supports boolean/number/string flags) */
function isTestLead(lead) {
  try {
    const m = lead?.metadata || {};
    const isTruthy = (v) =>
      v === true || v === 1 || v === "1" || String(v).toLowerCase() === "true";
    return isTruthy(m.test) || isTruthy(m.testMode) || isTruthy(m.call_now_test);
  } catch (_) {
    return false;
  }
}

/** Compute short test gap (seconds) aligned with NO_ANSWER test delays */
function testGapSecsForNextAttempt(currentAttemptNumber) {
  const ms1 = Number(process.env.TEST_CALL_DELAY_MS_1 ?? process.env.TEST_NO_ANSWER_DELAY_MS_1 ?? 90_000);
  const ms2 = Number(process.env.TEST_CALL_DELAY_MS_2 ?? process.env.TEST_NO_ANSWER_DELAY_MS_2 ?? 90_000);
  const ms3 = Number(process.env.TEST_CALL_DELAY_MS_3 ?? process.env.TEST_NO_ANSWER_DELAY_MS_3 ?? 90_000);
  const arr = [ms1, ms2, ms3];
  const idx = Math.max(0, Math.min(arr.length - 1, currentAttemptNumber - 1));
  const ms = arr[idx] ?? arr[0] ?? 90_000;
  // minimum 5s safety to avoid immediate duplicate enqueueing
  return Math.max(5, Math.floor(ms / 1000));
}

function pickDataCollections(d) {
  console.debug(
    `[DEBUG] pickDataCollections: Extracting data collections from: ${JSON.stringify(
      d
    ).slice(0, 100)}...`
  );
  const r = d?.analysis?.data_collection_results || {};
  const val = (k) => {
    const value = r[k]?.value ?? null;
    console.debug(`[DEBUG] pickDataCollections: Key ${k} value: ${value}`);
    return value;
  };
  const result = {
    availability: val("availability"),
    job_status: val("job_status"),
    salary_expectations: val("salary_expectations"),
    job_type: val("job_type"),
    job_field: val("job_field"),
  };
  console.debug(
    `[DEBUG] pickDataCollections: Returning: ${JSON.stringify(result)}`
  );
  return result;
}

/** ---------- POST to external backend (3 tries) ---------- */
async function postToExternal(payload) {
  console.debug(
    `[DEBUG] postToExternal: Starting POST with payload: ${JSON.stringify(
      payload
    ).slice(0, 100)}...`
  );
  const url = process.env.CRM_ENDPOINT;
  if (!url) {
    console.debug(`[DEBUG] postToExternal: No CRM_ENDPOINT set, skipping`);
    return;
  }

  const headers = { "Content-Type": "application/json" };
  console.debug(
    `[DEBUG] postToExternal: Using headers: ${JSON.stringify(headers)}`
  );

  let attempt = 0;
  let delay = 500;
  while (attempt < 3) {
    console.debug(`[DEBUG] postToExternal: Attempt ${attempt + 1} to ${url}`);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      console.debug(`[DEBUG] postToExternal: Response status: ${res.status}`);
      if (res.ok) {
        console.log("[CRM] posted ok");
        console.debug(`[DEBUG] postToExternal: Successful POST`);
        return;
      }
      const txt = await res.text().catch(() => "");
      console.warn("[CRM] post failed", res.status, txt);
      console.debug(
        `[DEBUG] postToExternal: Failed with status ${res.status}, text: ${txt}`
      );
    } catch (e) {
      console.warn("[CRM] error", e.message);
      console.debug(`[DEBUG] postToExternal: Error: ${e.message}`);
    }
    attempt++;
    console.debug(`[DEBUG] postToExternal: Waiting ${delay}ms before retry`);
    await new Promise((r) => setTimeout(r, delay));
    delay *= 2;
  }
  console.debug(`[DEBUG] postToExternal: All attempts failed`);
}

/** ---------- Route ---------- */
r.post("/elevenlabs", async (req, res) => {
  console.debug(`[DEBUG] POST /elevenlabs: Starting webhook processing`);
  try {
    const qcNow = nowIn(QUEBEC_TZ);
    console.log("[WEBHOOK]", {
      sig: req.headers["elevenlabs-signature"],
      rawLen: req.rawBody?.length,
      type: req.body?.type,
      quebecNow: qcNow.format("YYYY-MM-DD HH:mm:ss z"),
      window: `${START}:00–${END}:00`,
    });

    const disableAuth = process.env.DISABLE_WEBHOOK_AUTH === "1";
    const debugBypass =
      (req.headers["x-debug-pass"] || "") === (process.env.API_KEY || "");
    const hasValidHmac = verifyHmac(req);
    const staticOk =
      (req.headers["x-webhook-secret"] || "") ===
      (process.env.EL_WEBHOOK_SECRET || "");

    console.log("[WEBHOOK] auth:", {
      hasValidHmac,
      staticOk,
      disableAuth,
      debugBypass,
    });
    console.debug(
      `[DEBUG] POST /elevenlabs: Auth checks - hasValidHmac: ${hasValidHmac}, staticOk: ${staticOk}, disableAuth: ${disableAuth}, debugBypass: ${debugBypass}`
    );

    if (!disableAuth && !debugBypass && !hasValidHmac && !staticOk) {
      console.debug(
        `[DEBUG] POST /elevenlabs: Authentication failed, returning 200 with invalid signature note`
      );
      return res
        .status(200)
        .json({ ok: true, note: "invalid_signature_ignored_for_debug" });
    }

    const body = req.body || {};
    let outcome = "FAILED";
    let convoId = body.conversation_id || body.id || null;
    console.debug(
      `[DEBUG] POST /elevenlabs: Body type: ${body.type}, conversationId: ${convoId}`
    );

    let transcriptArr = null;
    let transcriptStr = null;
    let recordingUrl = null;
    let startedAt = null;
    let endedAt = null;

    let leadId = null;
    let emailFromMeta = null;
    let from_number = null;
    let to_number = null;

    let costCents = null;
    let durationSecs = null;
    let summary = null;
    let title = null;
    let termination = null;

    /** ---------- Structured payloads ---------- */
    if (body.type === "post_call_transcription" && body.data) {
      console.debug(`[DEBUG] POST /elevenlabs: Processing structured payload`);
      const d = body.data;
      outcome = mapOutcomeFromTranscription(d);
      console.debug(`[DEBUG] POST /elevenlabs: Mapped outcome: ${outcome}`);

      const m = d.metadata || {};
      const pc = m.phone_call || {};

      from_number =
        pc.external_number ||
        m.from_number ||
        m.caller_number ||
        m.user_number ||
        null;
      to_number =
        pc.agent_number ||
        m.to_number ||
        m.phone_number ||
        m.agent_number ||
        null;
      console.debug(
        `[DEBUG] POST /elevenlabs: From: ${from_number}, To: ${to_number}`
      );

      const dyn =
        d.conversation_initiation_client_data?.dynamic_variables || {};
      const sysCalled = dyn.system__called_number || null;
      const sysCaller = dyn.system__caller_id || null;
      console.debug(
        `[DEBUG] POST /elevenlabs: sysCalled: ${sysCalled}, sysCaller: ${sysCaller}`
      );

      const candidateLeadPhones = [from_number, sysCaller, m.caller_number]
        .map(normPhone)
        .filter(Boolean);
      console.debug(
        `[DEBUG] POST /elevenlabs: Candidate lead phones: ${candidateLeadPhones}`
      );

      from_number = normPhone(from_number) || normPhone(sysCaller);
      to_number = normPhone(to_number) || normPhone(sysCalled);
      console.debug(
        `[DEBUG] POST /elevenlabs: Normalized - From: ${from_number}, To: ${to_number}`
      );

      emailFromMeta = m.email || null;
      leadId = Number(dyn.lead_id) || Number(m.lead_id) || null;
      console.debug(
        `[DEBUG] POST /elevenlabs: emailFromMeta: ${emailFromMeta}, leadId: ${leadId}`
      );

      startedAt = m.started_at ? new Date(m.started_at) : null;
      endedAt = m.ended_at ? new Date(m.ended_at) : new Date();
      console.debug(
        `[DEBUG] POST /elevenlabs: startedAt: ${startedAt}, endedAt: ${endedAt}`
      );

      transcriptArr = Array.isArray(d.transcript) ? d.transcript : null;
      transcriptStr = transcriptArr ? JSON.stringify(transcriptArr) : null;
      if (transcriptStr && transcriptStr.length > 500_000) {
        transcriptStr = transcriptStr.slice(0, 500_000);
        console.debug(
          `[DEBUG] POST /elevenlabs: Transcript truncated to 500,000 chars`
        );
      }
      console.debug(
        `[DEBUG] POST /elevenlabs: Transcript array length: ${transcriptArr?.length}, string length: ${transcriptStr?.length}`
      );

      // Optional transcript logging (structured payload)
      try {
        const logTranscripts = (process.env.LOG_TRANSCRIPTS ?? "0") === "1";
        if (logTranscripts && transcriptStr) {
          const maxChars = Math.max(
            500,
            Number(process.env.TRANSCRIPT_LOG_MAX_CHARS ?? 4000)
          );
          const snippet = transcriptStr.slice(0, maxChars);
          console.log("[EL TRANSCRIPT][structured]", {
            conversation_id: d.conversation_id || convoId || null,
            length: transcriptStr.length,
            snippet,
          });
        }
      } catch (e) {
        console.debug(
          `[DEBUG] POST /elevenlabs: transcript logging failed: ${e?.message}`
        );
      }

      recordingUrl = d.recording_url || d.audio_url || null;
      console.debug(`[DEBUG] POST /elevenlabs: Recording URL: ${recordingUrl}`);

      costCents = Number(m.cost ?? null);
      durationSecs = Number(m.call_duration_secs ?? null);
      summary = d.analysis?.transcript_summary || null;
      title = d.analysis?.call_summary_title || null;
      termination = m.termination_reason || null;
      console.debug(
        `[DEBUG] POST /elevenlabs: costCents: ${costCents}, durationSecs: ${durationSecs}, summary: ${summary?.slice(
          0,
          50
        )}, title: ${title}, termination: ${termination}`
      );

      const dc = pickDataCollections(d);
      const dataCollectionsRaw = d?.analysis?.data_collection_results || {};
      console.debug(
        `[DEBUG] POST /elevenlabs: Data collections: ${JSON.stringify(dc)}`
      );

      /** ---------- Lead matching ---------- */
      let lead = null;
      if (leadId) {
        console.debug(
          `[DEBUG] POST /elevenlabs: Fetching lead by ID: ${leadId}`
        );
        lead = await prisma.lead.findUnique({ where: { id: leadId } });
        console.debug(
          `[DEBUG] POST /elevenlabs: Lead found: ${
            lead ? JSON.stringify(lead) : "null"
          }`
        );
      }
      if (!lead) {
        console.debug(
          `[DEBUG] POST /elevenlabs: No lead found by ID, trying phone numbers: ${candidateLeadPhones}`
        );
        for (const ph of candidateLeadPhones) {
          const found = await prisma.lead.findFirst({
            where: { phone: ph },
            orderBy: { createdAt: "desc" },
          });
          if (found) {
            lead = found;
            console.debug(
              `[DEBUG] POST /elevenlabs: Lead found by phone ${ph}: ${JSON.stringify(
                lead
              )}`
            );
            break;
          }
        }
      }

      if (!lead && process.env.AUTO_CREATE_LEAD_FROM_WEBHOOK === "1") {
        const tz = process.env.DEFAULT_TZ || QUEBEC_TZ;
        const phoneGuess = candidateLeadPhones[0] || from_number;
        console.debug(
          `[DEBUG] POST /elevenlabs: No lead found, auto-creating with phone: ${phoneGuess}, tz: ${tz}`
        );
        if (phoneGuess) {
          lead = await prisma.lead.create({
            data: {
              fbLeadId: null,
              fullName: "Inbound Lead",
              phone: phoneGuess,
              email: emailFromMeta || null,
              timezone: tz,
              status: "IN_PROGRESS",
              metadata: { created_from: "webhook_auto" },
            },
          });
          console.debug(
            `[DEBUG] POST /elevenlabs: Auto-created lead: ${JSON.stringify(
              lead
            )}`
          );
        }
      }
      if (!lead) {
        console.warn("[WEBHOOK] lead not found", {
          leadId,
          from_number,
          to_number,
          sysCalled,
          sysCaller,
        });
        console.debug(
          `[DEBUG] POST /elevenlabs: Lead not found, returning 200`
        );
        return res.status(200).json({ ok: true, note: "lead_not_found" });
      }

      if (emailFromMeta && (!lead.email || lead.email !== emailFromMeta)) {
        console.debug(
          `[DEBUG] POST /elevenlabs: Updating lead email to ${emailFromMeta}`
        );
        await prisma.lead.update({
          where: { id: lead.id },
          data: { email: emailFromMeta },
        });
        console.debug(`[DEBUG] POST /elevenlabs: Lead email updated`);
      }

      /** ---------- Update attempt & lead ---------- */
      // ---------- Update attempt & lead (IDEMPOTENT) ----------

      // 1) Try to locate the attempt by conversation_id (best signal)
      let attempt = null;
      if (convoId) {
        console.debug(
          `[DEBUG] POST /elevenlabs: Fetching attempt by conversationId: ${convoId}`
        );
        attempt = await prisma.callAttempt.findFirst({
          where: { leadId: lead.id, conversationId: convoId },
        });
        console.debug(
          `[DEBUG] POST /elevenlabs: Attempt found: ${
            attempt ? JSON.stringify(attempt) : "null"
          }`
        );
      }

      // 2) Fallback: most recent attempt in the last 45 mins
      if (!attempt) {
        const fortyFiveMinsAgo = new Date(Date.now() - 45 * 60 * 1000);
        console.debug(
          `[DEBUG] POST /elevenlabs: No attempt by convoId, checking attempts since ${fortyFiveMinsAgo}`
        );
        attempt = await prisma.callAttempt.findFirst({
          where: {
            leadId: lead.id,
            OR: [
              { startedAt: { gte: fortyFiveMinsAgo } },
              { scheduledAt: { gte: fortyFiveMinsAgo } },
            ],
          },
          orderBy: { attemptNumber: "desc" },
        });
        console.debug(
          `[DEBUG] POST /elevenlabs: Fallback attempt: ${
            attempt ? JSON.stringify(attempt) : "null"
          }`
        );
      }

      // 3) Last resort: create a new attempt row
      if (!attempt) {
        console.debug(
          `[DEBUG] POST /elevenlabs: No attempt found, creating new`
        );
        const last = await prisma.callAttempt.findFirst({
          where: { leadId: lead.id },
          orderBy: { attemptNumber: "desc" },
        });
        console.debug(
          `[DEBUG] POST /elevenlabs: Last attempt: ${
            last ? JSON.stringify(last) : "null"
          }`
        );

        attempt = await prisma.callAttempt.create({
          data: {
            leadId: lead.id,
            status: outcome,
            attemptNumber: (last?.attemptNumber ?? 0) + 1,
            scheduledAt: startedAt || new Date(),
            startedAt: startedAt || new Date(),
            conversationId: convoId || null,
            payload: {},
          },
        });
        console.debug(
          `[DEBUG] POST /elevenlabs: Created new attempt: ${JSON.stringify(
            attempt
          )}`
        );
      }

      // 4) Idempotency: if already finalized, do not change the attempt number or reschedule
      if (!FINAL_STATUSES.has(attempt.status)) {
        console.debug(
          `[DEBUG] POST /elevenlabs: Updating attempt ${attempt.id} (not finalized)`
        );
        attempt = await prisma.callAttempt.update({
          where: { id: attempt.id },
          data: {
            status: outcome,
            startedAt: startedAt || attempt.startedAt,
            endedAt: endedAt || new Date(),
            conversationId: attempt.conversationId || convoId || null,
            recordingUrl: recordingUrl || attempt.recordingUrl || null,
            transcript: transcriptStr ?? attempt.transcript ?? null,
            payload: body,
          },
        });
        console.debug(
          `[DEBUG] POST /elevenlabs: Updated attempt: ${JSON.stringify(
            attempt
          )}`
        );
      }

      // 5) Compute the true “current attempt number” and max attempts for the lead
      const maxAttempt = await prisma.callAttempt.findFirst({
        where: { leadId: lead.id },
        orderBy: { attemptNumber: "desc" },
      });
      const currentAttemptNumber = attempt.attemptNumber;
      const attemptsOnLead = maxAttempt?.attemptNumber ?? currentAttemptNumber;
      console.debug(
        `[DEBUG] POST /elevenlabs: Current attempt: ${currentAttemptNumber}, Max attempts: ${attemptsOnLead}`
      );

      // keep the lead in sync
      console.debug(
        `[DEBUG] POST /elevenlabs: Updating lead status for ${lead.id}`
      );
      // Sync lead email from metadata if present (structured path)
      try {
        if (emailFromMeta && (!lead.email || lead.email !== emailFromMeta)) {
          await prisma.lead.update({ where: { id: lead.id }, data: { email: emailFromMeta } });
          lead = await prisma.lead.findUnique({ where: { id: lead.id } });
          console.debug(`[DEBUG] POST /elevenlabs: Lead email synced from metadata: ${emailFromMeta}`);
        }
      } catch (e) {
        console.warn('[WEBHOOK] failed syncing lead email from metadata', e?.message);
      }
      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          status: outcome,
          lastOutcome: outcome,
          lastAttemptAt: new Date(),
          attempts: attemptsOnLead,
        },
      });
      console.debug(`[DEBUG] POST /elevenlabs: Lead updated`);

      try {
        // Immediate after-call email + SMS handled by notifications worker
        if (outcome === 'ANSWERED') {
          try {
            console.log('[NOTIFY] answered immediate: enqueueing (structured)', {
              leadId: lead.id,
              email: lead.email,
              phone: lead.phone,
              emailFromMeta,
            });
            await scheduleAnsweredImmediate(lead, {
              emailFromMeta,
              translated_job_types: d?.analysis?.translated_job_types || null,
              job_type: dc?.job_type ?? null,
              available_to_start: d?.analysis?.available_to_start || null,
              availability: dc?.availability ?? null,
              salary_expectation: d?.analysis?.salary_expectation || null,
              salary_expectations: dc?.salary_expectations ?? null,
              translated_user_categories: d?.analysis?.translated_user_categories || null,
              job_field: dc?.job_field ?? null,
              completion_link: process.env.BOOKING_URL || null,
            });
          } catch (e) {
            console.warn('[NOTIFY] answered immediate enqueue failed', e?.message);
          }
        }

        if (["ANSWERED", "NO_ANSWER", "FAILED"].includes(outcome)) {
          console.debug(
            `[DEBUG] POST /elevenlabs: Triggering notifications for outcome ${outcome}`
          );
          await handleQuickAttemptNotifications({
            lead,
            attemptNumber: currentAttemptNumber,
            outcome: outcome === "FAILED" ? "NO_ANSWER" : outcome,
          });
          console.debug(`[DEBUG] POST /elevenlabs: Notifications triggered`);
        }

        // If answered, cancel any future scheduled attempts and clear nextScheduledAt
        if (outcome === "ANSWERED") {
          try {
            await prisma.callAttempt.updateMany({
              where: {
                leadId: lead.id,
                status: "SCHEDULED",
                attemptNumber: { gt: currentAttemptNumber },
              },
              data: { status: "CANCELED" },
            });
            await prisma.lead.update({
              where: { id: lead.id },
              data: { nextScheduledAt: null },
            });
          } catch (e) {
            console.warn("[WEBHOOK] failed to cancel future attempts after ANSWERED", e?.message);
          }
        }
      } catch (e) {
        console.warn("[NOTIFY] attempt notifications failed", e?.message);
        console.debug(
          `[DEBUG] POST /elevenlabs: Notification error: ${e.message}`
        );
      }

      /** ---------- Push to external backend ---------- */
      console.debug(`[DEBUG] POST /elevenlabs: Posting to external backend`);
      postToExternal({
        leadId: lead.id,
        fullName: lead.fullName,
        phone: lead.phone,
        email: lead.email || emailFromMeta || null,
        outcome,
        conversationId: d.conversation_id || convoId || null,
        startedAt: (startedAt || null)?.toISOString?.() || null,
        endedAt: (endedAt || null)?.toISOString?.() || null,
        durationSecs: durationSecs ?? null,
        costCents: costCents ?? null,
        terminationReason: termination,
        summary,
        summaryTitle: title,
        availability: dc.availability,
        job_status: dc.job_status,
        salary_expectations: dc.salary_expectations,
        job_type: dc.job_type,
        job_field: dc.job_field,
        dataCollectionsRaw,
        transcript: transcriptArr || [],
        raw: body,
      }).catch((e) => {
        console.debug(
          `[DEBUG] POST /elevenlabs: External post error: ${e.message}`
        );
      });

      // ---------- Next attempt policy ----------
      // Do not schedule any further calls if the user answered at least once.
      if (attemptsOnLead < MAX_ATTEMPTS && outcome !== "ANSWERED") {
        console.debug(
          `[DEBUG] POST /elevenlabs: Scheduling next attempt for outcome ${outcome}`
        );
        // Do NOT double-schedule if the next attempt already exists
        const nextAttemptExists = await prisma.callAttempt.findUnique({
          where: {
            leadId_attemptNumber: {
              leadId: lead.id,
              attemptNumber: currentAttemptNumber + 1,
            },
          },
          select: { id: true },
        });
        console.debug(
          `[DEBUG] POST /elevenlabs: Next attempt exists: ${
            nextAttemptExists ? "yes" : "no"
          }`
        );

        if (!nextAttemptExists) {
          const testLead = isTestLead(lead);
          const tz = pickTz(lead.timezone || QUEBEC_TZ);

          if (testLead) {
            // TEST MODE: disregard business window; schedule with minimal gap (aligned with NO_ANSWER flow)
            const gapSecs = testGapSecsForNextAttempt(currentAttemptNumber + 1);
            const scheduledUnix = Math.floor(Date.now() / 1000) + gapSecs;
            const scheduledAt = new Date(scheduledUnix * 1000);
            const attempt = await prisma.callAttempt.create({
              data: {
                leadId: lead.id,
                attemptNumber: currentAttemptNumber + 1,
                status: "SCHEDULED",
                scheduledAt,
                payload: { schedule_reason: outcome, test: true, gap_secs: gapSecs },
              },
            });
            await prisma.lead.update({
              where: { id: lead.id },
              data: {
                status: "SCHEDULED",
                nextScheduledAt: scheduledAt,
                attempts: currentAttemptNumber + 1,
              },
            });
            await enqueueCallForAttempt({
              leadId: lead.id,
              attemptId: attempt.id,
              attemptNumber: currentAttemptNumber + 1,
              scheduledUnix,
            });
            console.log("[WEBHOOK] next attempt scheduled (test)", {
              leadId: lead.id,
              attemptNumber: currentAttemptNumber + 1,
              when_local: moment(scheduledAt).tz(tz).format("YYYY-MM-DD HH:mm:ss z"),
              gap_secs: gapSecs,
            });
          } else {
            // NORMAL MODE: schedule next working day within window
            const { attempt, scheduledUnix } = await reserveCallSlotAndCreateAttempt({
              leadId: lead.id,
              attemptNumber: currentAttemptNumber + 1,
              tz,
            });
            await enqueueCallForAttempt({
              leadId: lead.id,
              attemptId: attempt.id,
              attemptNumber: currentAttemptNumber + 1,
              scheduledUnix,
            });
            console.log("[WEBHOOK] next attempt scheduled", {
              leadId: lead.id,
              attemptNumber: currentAttemptNumber + 1,
              when_local: moment
                .unix(scheduledUnix)
                .tz(tz)
                .format("YYYY-MM-DD HH:mm:ss z"),
            });
          }
        }
      }

      console.log("[WEBHOOK] processed (structured):", {
        leadId: lead.id,
        outcome,
        from_number,
        to_number,
        attempts: attemptsOnLead,
      });
      // For testing only when queue disabled; avoid double-processing when BullMQ is enabled
      if (!NOTIFY_QUEUE_ENABLED) {
        try {
          await processScheduledNotifications(200);
        } catch (e) {}
      }
      console.debug(`[DEBUG] POST /elevenlabs: Structured processing complete`);
      return res.json({ ok: true });
    } // <-- CLOSE the structured branch here

    /** ---------- Fallback: flat payloads ---------- */
    /** ---------- Fallback: flat payloads ---------- */
    /** ---------- Fallback: flat payloads ---------- */
    console.debug(`[DEBUG] POST /elevenlabs: Processing flat payload`);
    const statusMap = {
      answered: "ANSWERED",
      voicemail: "NO_ANSWER",
      answering_machine: "NO_ANSWER",
      "answering-machine": "NO_ANSWER",
      machine: "NO_ANSWER",
      "no-answer": "NO_ANSWER",
      no_answer: "NO_ANSWER",
      noanswer: "NO_ANSWER",
      failed: "FAILED",
    };
    const rawOutcome = String(body.outcome || "").toLowerCase();
    outcome = statusMap[rawOutcome] || "FAILED";
    console.debug(
      `[DEBUG] POST /elevenlabs: Flat outcome: ${outcome} from raw: ${rawOutcome}`
    );
    try {
      const LOG_SIGNALS = (process.env.LOG_EL_SIGNALS ?? "0") === "1";
      if (LOG_SIGNALS) {
        console.log("[EL DECISION][flat]", {
          outcome,
          rawOutcome,
          transcript_present: Boolean(body?.transcript),
          transcript_type: Array.isArray(body?.transcript) ? "array" : typeof body?.transcript,
        });
      }
    } catch {}

    to_number = normPhone(body.to_number || body.phone_number || null);
    leadId = Number(body?.metadata?.lead_id) || null;
    emailFromMeta = body?.metadata?.email || null;
    console.debug(
      `[DEBUG] POST /elevenlabs: to_number: ${to_number}, leadId: ${leadId}, emailFromMeta: ${emailFromMeta}`
    );

    transcriptArr = Array.isArray(body?.transcript) ? body.transcript : null;
    transcriptStr = transcriptArr
      ? JSON.stringify(transcriptArr)
      : typeof body?.transcript === "string"
      ? body.transcript
      : null;
    if (transcriptStr && transcriptStr.length > 500_000) {
      transcriptStr = transcriptStr.slice(0, 500_000);
      console.debug(
        `[DEBUG] POST /elevenlabs: Flat transcript truncated to 500,000 chars`
      );
    }
    console.debug(
      `[DEBUG] POST /elevenlabs: Flat transcript array length: ${transcriptArr?.length}, string length: ${transcriptStr?.length}`
    );

    // Optional transcript logging (flat payload)
    try {
      const logTranscripts = (process.env.LOG_TRANSCRIPTS ?? "0") === "1";
      if (logTranscripts && transcriptStr) {
        const maxChars = Math.max(
          500,
          Number(process.env.TRANSCRIPT_LOG_MAX_CHARS ?? 4000)
        );
        const snippet = transcriptStr.slice(0, maxChars);
        console.log("[EL TRANSCRIPT][flat]", {
          conversation_id: body.conversation_id || body.id || null,
          length: transcriptStr.length,
          snippet,
        });
      }
    } catch (e) {
      console.debug(
        `[DEBUG] POST /elevenlabs: transcript logging failed (flat): ${e?.message}`
      );
    }

    recordingUrl = body?.recording_url || null;
    startedAt = body?.started_at ? new Date(body.started_at) : null;
    endedAt = body?.ended_at ? new Date(body.ended_at) : new Date();
    console.debug(
      `[DEBUG] POST /elevenlabs: recordingUrl: ${recordingUrl}, startedAt: ${startedAt}, endedAt: ${endedAt}`
    );

    // Override flat 'answered' if it's a short connect without human speech
    try {
      const MIN_ANSWER_SECS = Math.max(1, Number(process.env.MIN_ANSWER_DURATION_SECS ?? 10));
      const durSecs = startedAt && endedAt ? Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)) : Number(body?.call_duration_secs ?? 0);
      const transcriptArrFlat = Array.isArray(transcriptArr) ? transcriptArr : [];
      const textOf = (m) => String(m?.message ?? m?.original_message ?? m?.text ?? m?.transcript ?? m?.content ?? "");
      const speakerOf = (m) => String(m?.speaker ?? m?.role ?? m?.sender ?? m?.source ?? m?.speaker_name ?? "");
      const humanUtterFlat = transcriptArrFlat.some((m) => {
        const text = textOf(m).trim();
        const speakerRaw = speakerOf(m).toLowerCase();
        const isAgent = m?.is_agent === true || /\b(agent|assistant|ai|bot)\b/.test(speakerRaw);
        const isHuman = m?.is_agent === false || speakerRaw === "user" || /\b(user|human|caller|lead|callee|customer|person)\b/.test(speakerRaw);
        return !isAgent && isHuman && text.length >= 2;
      });
      const termFlat = String(body?.termination_reason || body?.metadata?.termination_reason || "").toLowerCase();
      const DECLINE_TERMS = ["declined", "rejected", "cancelled", "canceled", "hangup", "hung up", "user busy", "caller hung up"];
      const isDeclineTerm = DECLINE_TERMS.some((p) => termFlat.includes(p));
      if (outcome === "ANSWERED" && ((durSecs > 0 && durSecs < MIN_ANSWER_SECS && !humanUtterFlat) || (isDeclineTerm && !humanUtterFlat))) {
        console.debug(
          `[DEBUG] POST /elevenlabs: Flat override ANSWERED->NO_ANSWER (dur=${durSecs}s, human=${humanUtterFlat}, term=${termFlat})`
        );
        outcome = "NO_ANSWER";
      }
    } catch (e) {
      console.debug(`[DEBUG] POST /elevenlabs: Flat short-call override failed: ${e?.message}`);
    }

    let lead = null;
    if (leadId) {
      console.debug(
        `[DEBUG] POST /elevenlabs: Fetching lead by ID: ${leadId} (flat)`
      );
      lead = await prisma.lead.findUnique({ where: { id: leadId } });
      console.debug(
        `[DEBUG] POST /elevenlabs: Lead found: ${
          lead ? JSON.stringify(lead) : "null"
        }`
      );
    }

    if (!lead) {
      console.warn("[WEBHOOK] lead not found (flat)", { leadId, to_number });
      console.debug(
        `[DEBUG] POST /elevenlabs: Lead not found (flat), returning 200`
      );
      return res.status(200).json({ ok: true, note: "lead_not_found" });
    }

    if (emailFromMeta && (!lead.email || lead.email !== emailFromMeta)) {
      console.debug(
        `[DEBUG] POST /elevenlabs: Updating lead email to ${emailFromMeta} (flat)`
      );
      await prisma.lead.update({
        where: { id: lead.id },
        data: { email: emailFromMeta },
      });
      console.debug(`[DEBUG] POST /elevenlabs: Lead email updated (flat)`);
    }

    const maxAttempt = await prisma.callAttempt.findFirst({
      where: { leadId: lead.id },
      orderBy: { attemptNumber: "desc" },
    });
    const attemptsCount = maxAttempt?.attemptNumber ?? 0;
    console.debug(`[DEBUG] POST /elevenlabs: Max attempts: ${attemptsCount}`);

    if (attemptsCount >= MAX_ATTEMPTS) {
      console.warn(
        `[WEBHOOK] Max attempts (${MAX_ATTEMPTS}) reached for lead ${lead.id}, no further retries scheduled`
      );
    } else {
      await prisma.callAttempt.upsert({
        where: {
          leadId_attemptNumber: {
            leadId: lead.id,
            attemptNumber: attemptsCount + 1,
          },
        },
        create: {
          leadId: lead.id,
          attemptNumber: attemptsCount + 1,
          status: outcome,
          scheduledAt: new Date(),
          startedAt: startedAt || null,
          endedAt: endedAt || new Date(),
          conversationId: convoId,
          recordingUrl,
          transcript: transcriptStr,
          payload: body,
        },
        update: {
          status: outcome,
          startedAt: startedAt || undefined,
          endedAt: endedAt || new Date(),
          conversationId: convoId,
          recordingUrl,
          transcript: transcriptStr,
          payload: body,
        },
      });
      console.debug(`[DEBUG] POST /elevenlabs: Call attempt upserted`);

      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          status: outcome,
          lastOutcome: outcome,
          lastAttemptAt: new Date(),
          attempts: attemptsCount + 1,
        },
      });
      console.debug(`[DEBUG] POST /elevenlabs: Lead updated (flat)`);
    }

    try {
      if (["ANSWERED", "NO_ANSWER", "FAILED"].includes(outcome)) {
        console.debug(
          `[DEBUG] POST /elevenlabs: Triggering notifications for outcome ${outcome} (flat)`
        );
        await handleQuickAttemptNotifications({
          lead,
          attemptNumber: attemptsCount + 1,
          outcome: outcome === "FAILED" ? "NO_ANSWER" : outcome,
        });
        console.debug(
          `[DEBUG] POST /elevenlabs: Notifications triggered (flat)`
        );
      }
      // Immediate after-call email + SMS (flat payloads) handled by notifications worker
      if (outcome === 'ANSWERED') {
        try {
          const completion_link = process.env.BOOKING_URL || null;
          console.log('[NOTIFY] answered immediate: enqueueing (flat)', {
            leadId: lead.id,
            email: lead.email,
            phone: lead.phone,
            emailFromMeta,
          });
          await scheduleAnsweredImmediate(lead, {
            emailFromMeta,
            translated_job_types: getDC('translated_job_types'),
            job_type: getDC('job_type'),
            available_to_start: getDC('available_to_start'),
            availability: getDC('availability'),
            salary_expectation: getDC('salary_expectation'),
            salary_expectations: getDC('salary_expectations'),
            translated_user_categories: getDC('translated_user_categories'),
            job_field: getDC('job_field'),
            completion_link,
          });
        } catch (e) {
          console.warn('[NOTIFY] answered immediate enqueue failed (flat)', e?.message);
        }
      }
    } catch (e) {
      console.warn("[NOTIFY] attempt notifications failed (flat)", e?.message);
      console.debug(
        `[DEBUG] POST /elevenlabs: Notification error (flat): ${e.message}`
      );
    }

    const dc = body?.analysis?.data_collection_results;
    function getDC(key) {
      if (!dc) {
        console.debug(
          `[DEBUG] POST /elevenlabs: No data collections for key ${key}`
        );
        return null;
      }
      if (Array.isArray(dc)) {
        const value =
          dc.find((i) => i?.key === key || i?.name === key)?.value ?? null;
        console.debug(
          `[DEBUG] POST /elevenlabs: Array DC key ${key}: ${value}`
        );
        return value;
      }
      if (typeof dc === "object") {
        const value = dc[key]?.value ?? dc[key] ?? null;
        console.debug(
          `[DEBUG] POST /elevenlabs: Object DC key ${key}: ${value}`
        );
        return value;
      }
      console.debug(
        `[DEBUG] POST /elevenlabs: Invalid DC format for key ${key}`
      );
      return null;
    }

    console.debug(
      `[DEBUG] POST /elevenlabs: Posting to external backend (flat)`
    );
    postToExternal({
      leadId: lead.id,
      fullName: lead.fullName,
      phone: lead.phone,
      email: lead.email || emailFromMeta || null,
      outcome,
      conversationId: body.conversation_id || body.id || null,
      startedAt: (startedAt || null)?.toISOString?.() || null,
      endedAt: (endedAt || null)?.toISOString?.() || null,
      durationSecs: null,
      costCents: null,
      terminationReason: null,
      summary: getDC("summary"),
      summaryTitle: getDC("summaryTitle"),
      availability: getDC("availability"),
      job_status: getDC("job_status"),
      salary_expectations: getDC("salary_expectations"),
      job_type: getDC("job_type"),
      job_field: getDC("job_field"),
      dataCollectionsRaw: dc || {},
      transcript:
        transcriptArr ||
        (typeof body?.transcript === "string" ? body.transcript : null),
      raw: body,
    }).catch((e) => {
      console.debug(
        `[DEBUG] POST /elevenlabs: External post error (flat): ${e.message}`
      );
    });

    // Do not schedule next attempts if this lead has ANSWERED
    if (attemptsCount < MAX_ATTEMPTS && outcome !== "ANSWERED") {
      console.debug(
        `[DEBUG] POST /elevenlabs: Scheduling next attempt (flat), attemptsCount: ${attemptsCount}`
      );
      const tz = pickTz(lead.timezone || QUEBEC_TZ);
      console.debug(`[DEBUG] POST /elevenlabs: Using timezone ${tz} (flat)`);

      const nextAttemptExists = await prisma.callAttempt.findUnique({
        where: {
          leadId_attemptNumber: {
            leadId: lead.id,
            attemptNumber: attemptsCount + 1,
          },
        },
        select: { id: true },
      });
      console.debug(
        `[DEBUG] POST /elevenlabs: Next attempt exists: ${
          nextAttemptExists ? "yes" : "no"
        }`
      );

      if (!nextAttemptExists) {
        const testLead = isTestLead(lead);
        if (testLead) {
          const gapSecs = testGapSecsForNextAttempt(attemptsCount + 1);
          const scheduledUnix = Math.floor(Date.now() / 1000) + gapSecs;
          const scheduledAt = new Date(scheduledUnix * 1000);
          const attempt = await prisma.callAttempt.upsert({
            where: {
              leadId_attemptNumber: {
                leadId: lead.id,
                attemptNumber: attemptsCount + 1,
              },
            },
            create: {
              leadId: lead.id,
              attemptNumber: attemptsCount + 1,
              status: "SCHEDULED",
              scheduledAt,
              payload: { schedule_reason: outcome, test: true, gap_secs: gapSecs },
            },
            update: { scheduledAt },
          });
          await prisma.lead.update({
            where: { id: lead.id },
            data: {
              status: "SCHEDULED",
              nextScheduledAt: scheduledAt,
              attempts: attemptsCount + 1,
            },
          });
          await enqueueCallForAttempt({
            leadId: lead.id,
            attemptId: attempt.id,
            attemptNumber: attemptsCount + 1,
            scheduledUnix,
          });
          console.log("[WEBHOOK] next attempt scheduled (flat,test)", {
            leadId: lead.id,
            attemptNumber: attemptsCount + 1,
            when_local: moment(scheduledAt).tz(tz).format("YYYY-MM-DD HH:mm:ss z"),
            gap_secs: gapSecs,
          });
        } else {
          const { attempt, scheduledUnix } = await reserveCallSlotAndCreateAttempt({
            leadId: lead.id,
            attemptNumber: attemptsCount + 1,
            tz,
          });
          await enqueueCallForAttempt({
            leadId: lead.id,
            attemptId: attempt.id,
            attemptNumber: attemptsCount + 1,
            scheduledUnix,
          });
          console.log("[WEBHOOK] next attempt scheduled (flat)", {
            leadId: lead.id,
            attemptNumber: attemptsCount + 1,
            when_local: moment
              .unix(scheduledUnix)
              .tz(tz)
              .format("YYYY-MM-DD HH:mm:ss z"),
          });
        }
      }
    } else if (outcome === "ANSWERED") {
      try {
        await prisma.callAttempt.updateMany({
          where: {
            leadId: lead.id,
            status: "SCHEDULED",
            attemptNumber: { gt: attemptsCount },
          },
          data: { status: "CANCELED" },
        });
        await prisma.lead.update({
          where: { id: lead.id },
          data: { nextScheduledAt: null },
        });
      } catch (e) {
        console.warn("[WEBHOOK] failed to cancel future attempts after ANSWERED (flat)", e?.message);
      }
    }

    console.log("[WEBHOOK] processed (flat):", {
      leadId: lead.id,
      outcome,
      attempts: attemptsCount,
    });
    if (!NOTIFY_QUEUE_ENABLED) {
      try {
        await processScheduledNotifications(200);
      } catch (e) {}
    }
    console.debug(`[DEBUG] POST /elevenlabs: Flat processing complete`);
    return res.json({ ok: true });
  } catch (e) {
    console.error("[WEBHOOK error]", e);
    console.debug(`[DEBUG] POST /elevenlabs: Error: ${e.message}`);
    // Keep 200 to avoid EL retries storms, but note the error
    return res.status(200).json({ ok: true, note: "error_swallowed_for_el" });
  }
});

export default r;
