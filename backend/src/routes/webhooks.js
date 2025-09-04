// routes/webhooks.js (cleaned + safer)
import { PrismaClient } from "@prisma/client";
import moment from "moment-timezone";
import { Router } from "express";
import fetch from "node-fetch";
import crypto from "crypto";

import {
  START,
  END,
  pickTz,
  rollForwardToWindowUnix,
  ceilToSlotUnix,
} from "../lib/schedule.js";
import { handleAttemptNotifications } from "../lib/notifications.js";
import { nowIn, QUEBEC_TZ } from "../lib/quebecTime.js";

const prisma = new PrismaClient();
const r = Router();
const SLOT_SECS = 300; // 5 minutes

// ----------------------- HMAC verify -----------------------
function verifyHmac(req) {
  const secret = process.env.EL_WEBHOOK_SECRET || "";
  const header = req.headers["elevenlabs-signature"] || "";
  if (!secret || !header || !req.rawBody) return false;

  const parts = Object.fromEntries(
    header.split(",").map((s) => {
      const [k, ...rest] = s.trim().split("=");
      return [k, rest.join("=")];
    })
  );
  const t = parts.t;
  let v0 = parts.v0 || "";
  if (!t || !v0) return false;

  if (v0.startsWith("sha256=")) v0 = v0.slice("sha256=".length);
  v0 = v0.trim().toLowerCase();

  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(t, 10);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 30 * 60) return false;

  const payload = `${t}.${req.rawBody.toString("utf8")}`;
  const hex = crypto.createHmac("sha256", secret).update(payload).digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(hex, "hex"),
      Buffer.from(v0, "hex")
    );
  } catch {
    return false;
  }
}

// ----------------------- helpers -----------------------
function normPhone(p) {
  if (!p) return null;
  const digits = String(p).replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return digits;
}

function mapOutcomeFromTranscription(data) {
  const cs = data.analysis?.call_successful;
  const success =
    cs === true ||
    String(cs).toLowerCase() === "true" ||
    String(cs).toLowerCase() === "success";
  const term = String(data.metadata?.termination_reason || "").toLowerCase();

  if (success) return "ANSWERED";
  if (term.includes("voicemail")) return "VOICEMAIL";
  if (
    term.includes("no_answer") ||
    term.includes("no-answer") ||
    term.includes("noanswer") ||
    term.includes("silence") ||
    term.includes("busy")
  )
    return "NO_ANSWER";
  if (
    term.includes("carrier_error") ||
    term.includes("error") ||
    term.includes("failed")
  )
    return "FAILED";
  return "FAILED";
}

function pickDataCollections(d) {
  const r = d?.analysis?.data_collection_results || {};
  const val = (k) => r[k]?.value ?? null;
  return {
    availability: val("availability"),
    job_status: val("job_status"),
    salary_expectations: val("salary_expectations"),
    job_type: val("job_type"),
    job_field: val("job_field"),
  };
}

async function postToExternal(payload) {
  const url = process.env.CRM_ENDPOINT;
  if (!url) return;
  const headers = { "Content-Type": "application/json" };

  let attempt = 0;
  let delay = 500;
  while (attempt < 3) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      if (res.ok) return console.log("[CRM] posted ok");
      const txt = await res.text().catch(() => "");
      console.warn("[CRM] post failed", res.status, txt);
    } catch (e) {
      console.warn("[CRM] error", e.message);
    }
    attempt++;
    await new Promise((r) => setTimeout(r, delay));
    delay *= 2;
  }
}

// ----------------------- core: find/attach attempt safely -----------------------
async function findAttemptForWebhook(
  tx,
  leadId,
  { conversationId, startedAt }
) {
  // 1) Best: exact match by external conversation id if we already stored it
  if (conversationId) {
    const byConvo = await tx.callAttempt.findFirst({
      where: { leadId, conversationExternalId: conversationId },
      orderBy: { attemptNumber: "desc" },
    });
    if (byConvo) return byConvo;
  }

  // 2) Otherwise: pick latest SCHEDULED attempt due before now (or a bit after startedAt)
  const cutoff = startedAt
    ? new Date(Math.max(Date.now(), startedAt.getTime()))
    : new Date();
  const bySchedule = await tx.callAttempt.findFirst({
    where: {
      leadId,
      status: "SCHEDULED",
      scheduledAt: { lte: cutoff },
    },
    orderBy: [{ attemptNumber: "desc" }, { scheduledAt: "desc" }],
  });
  if (bySchedule) return bySchedule;

  // 3) Fallback: latest attempt for this lead
  return tx.callAttempt.findFirst({
    where: { leadId },
    orderBy: { attemptNumber: "desc" },
  });
}

// ----------------------- schedule next attempt -----------------------
function computeNextAttemptUnix(tz) {
  // Next business day at START, aligned to 5-min bin
  const zone = pickTz(tz || QUEBEC_TZ);
  let unix = moment
    .tz(zone)
    .add(1, "day")
    .hour(START)
    .minute(0)
    .second(0)
    .millisecond(0)
    .unix();
  // skip weekends
  let m = moment.unix(unix).tz(zone);
  while ([0, 6].includes(m.day())) {
    m = m.add(1, "day").hour(START).minute(0).second(0).millisecond(0);
  }
  unix = m.unix();
  unix = ceilToSlotUnix(unix);
  unix = rollForwardToWindowUnix(unix, zone); // safety clamp (no-op if already good)
  return unix;
}

// ----------------------- route -----------------------
r.post("/elevenlabs", async (req, res) => {
  try {
    const qcNow = nowIn(QUEBEC_TZ);
    const disableAuth = process.env.DISABLE_WEBHOOK_AUTH === "1";
    const debugBypass =
      (req.headers["x-debug-pass"] || "") === (process.env.API_KEY || "");
    const hasValidHmac = verifyHmac(req);
    const staticOk =
      (req.headers["x-webhook-secret"] || "") ===
      (process.env.EL_WEBHOOK_SECRET || "");

    if (!disableAuth && !debugBypass && !hasValidHmac && !staticOk) {
      // Acknowledge (don’t retry storm), but don’t process
      return res
        .status(200)
        .json({ ok: true, note: "invalid_signature_ignored" });
    }

    const body = req.body || {};
    const kind = body.type;
    let outcome = "FAILED";

    // Normalize a few fields across payload shapes
    let conversationId = body.conversation_id || body.id || null;
    let startedAt = null;
    let endedAt = null;
    let recordingUrl = null;
    let transcriptArr = null;
    let transcriptStr = null;
    let emailFromMeta = null;
    let from_number = null;
    let to_number = null;
    let durationSecs = null;
    let costCents = null;
    let summary = null;
    let title = null;

    // -------------------- Structured payload --------------------
    if (kind === "post_call_transcription" && body.data) {
      const d = body.data;
      outcome = mapOutcomeFromTranscription(d);

      const m = d.metadata || {};
      const pc = m.phone_call || {};
      from_number = normPhone(
        pc.external_number ||
          m.from_number ||
          m.caller_number ||
          m.user_number ||
          null
      );
      to_number = normPhone(
        pc.agent_number ||
          m.to_number ||
          m.phone_number ||
          m.agent_number ||
          null
      );

      const dyn =
        d.conversation_initiation_client_data?.dynamic_variables || {};
      const sysCalled = dyn.system__called_number || null;
      const sysCaller = dyn.system__caller_id || null;
      const candidateLeadPhones = [
        from_number,
        normPhone(sysCaller),
        normPhone(m.caller_number),
      ]
        .map(normPhone)
        .filter(Boolean);

      emailFromMeta = m.email || null;

      startedAt = m.started_at ? new Date(m.started_at) : null;
      endedAt = m.ended_at ? new Date(m.ended_at) : new Date();
      transcriptArr = Array.isArray(d.transcript) ? d.transcript : null;
      transcriptStr = transcriptArr ? JSON.stringify(transcriptArr) : null;
      if (transcriptStr && transcriptStr.length > 500_000)
        transcriptStr = transcriptStr.slice(0, 500_000);
      recordingUrl = d.recording_url || d.audio_url || null;
      durationSecs = Number(m.call_duration_secs ?? null);
      costCents = Number(m.cost ?? null);
      summary = d.analysis?.transcript_summary || null;
      title = d.analysis?.call_summary_title || null;

      const dc = pickDataCollections(d);
      const dataCollectionsRaw = d?.analysis?.data_collection_results || {};

      // -------------------- Lead lookup + tx lock --------------------
      // Prefer explicit lead_id if present
      let lead =
        (dyn.lead_id &&
          (await prisma.lead.findUnique({
            where: { id: Number(dyn.lead_id) },
          }))) ||
        null;

      if (!lead) {
        for (const ph of candidateLeadPhones) {
          const found = await prisma.lead.findFirst({
            where: { phone: ph },
            orderBy: { createdAt: "desc" },
          });
          if (found) {
            lead = found;
            break;
          }
        }
      }

      if (!lead && process.env.AUTO_CREATE_LEAD_FROM_WEBHOOK === "1") {
        const tz = process.env.DEFAULT_TZ || QUEBEC_TZ;
        const phoneGuess = candidateLeadPhones[0] || from_number;
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
        }
      }

      if (!lead) {
        console.warn("[WEBHOOK] lead not found", {
          from_number,
          to_number,
          conversationId,
        });
        return res.status(200).json({ ok: true, note: "lead_not_found" });
      }

      // -------------------- Transaction: lock lead, update attempt & schedule next if needed --------------------
      await prisma.$transaction(async (tx) => {
        // lock lead.id cross-instance
        const got =
          await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(${BigInt(
            lead.id
          )}) AS ok;`;
        if (!got?.[0]?.ok) {
          // Someone else is finalizing; ack gracefully
          return;
        }

        // idempotency: if we already finalized this conversation for this lead, exit
        if (conversationId) {
          const already = await tx.callAttempt.findFirst({
            where: {
              leadId: lead.id,
              conversationExternalId: conversationId,
              status: {
                in: [
                  "ANSWERED",
                  "VOICEMAIL",
                  "NO_ANSWER",
                  "FAILED",
                  "CANCELED",
                ],
              },
            },
          });
          if (already) return; // duplicate webhook
        }

        // attach to the correct attempt
        const attempt = await findAttemptForWebhook(tx, lead.id, {
          conversationId,
          startedAt,
        });

        if (!attempt) {
          // No attempt found; create a minimal record so we don’t lose the call
          await tx.callAttempt.create({
            data: {
              leadId: lead.id,
              attemptNumber: (lead.attempts ?? 0) + 1,
              status: outcome,
              scheduledAt: startedAt || new Date(),
              startedAt: startedAt || null,
              endedAt: endedAt || new Date(),
              conversationId: conversationId || null,
              conversationExternalId: conversationId || null,
              recordingUrl: recordingUrl || null,
              transcript: transcriptStr || null,
              payload: body,
            },
          });
        } else {
          // If that attempt is already finalized with same conversation, treat as idempotent
          if (
            attempt.conversationExternalId === conversationId &&
            [
              "ANSWERED",
              "VOICEMAIL",
              "NO_ANSWER",
              "FAILED",
              "CANCELED",
            ].includes(attempt.status)
          ) {
            return;
          }

          await tx.callAttempt.update({
            where: { id: attempt.id },
            data: {
              status: outcome,
              startedAt: startedAt || attempt.startedAt,
              endedAt: endedAt || new Date(),
              conversationId: conversationId || attempt.conversationId,
              conversationExternalId:
                conversationId || attempt.conversationExternalId,
              recordingUrl: recordingUrl ?? attempt.recordingUrl ?? null,
              transcript: transcriptStr ?? attempt.transcript ?? null,
              payload: body,
            },
          });
        }

        // refresh attempts count (latest attemptNumber)
        const latest = await tx.callAttempt.findFirst({
          where: { leadId: lead.id },
          orderBy: { attemptNumber: "desc" },
          select: { attemptNumber: true },
        });
        const attemptsCount = latest?.attemptNumber ?? lead.attempts ?? 1;

        // update lead status
        await tx.lead.update({
          where: { id: lead.id },
          data: {
            status: outcome,
            lastOutcome: outcome,
            lastAttemptAt: new Date(),
            attempts: attemptsCount,
          },
        });

        // notifications (NO_ANSWER path)
        try {
          if (outcome === "NO_ANSWER") {
            await handleAttemptNotifications({
              lead,
              attemptNumber: attemptsCount,
              outcome,
            });
          }
        } catch (e) {
          console.warn("[NOTIFY] attempt notifications failed", e?.message);
        }

        // CRM post (fire-and-forget)
        postToExternal({
          leadId: lead.id,
          fullName: lead.fullName,
          phone: lead.phone,
          email: lead.email || emailFromMeta || null,
          outcome,
          conversationId,
          startedAt: (startedAt || null)?.toISOString?.() || null,
          endedAt: (endedAt || null)?.toISOString?.() || null,
          durationSecs,
          costCents,
          terminationReason: body?.data?.metadata?.termination_reason ?? null,
          summary,
          summaryTitle: title,
          ...pickDataCollections(body.data),
          dataCollectionsRaw:
            body?.data?.analysis?.data_collection_results || {},
          transcript: transcriptArr || [],
          raw: body,
        }).catch(() => {});

        // schedule next attempt if retryable and within cap
        const maxAttempts = lead.maxAttempts ?? 3;
        const retryable = ["FAILED", "NO_ANSWER", "VOICEMAIL"];
        if (retryable.includes(outcome) && attemptsCount < maxAttempts) {
          const nextUnix = computeNextAttemptUnix(lead.timezone || QUEBEC_TZ);
          const nextAt = new Date(nextUnix * 1000);

          // allocate the next attempt number (attemptsCount + 1) as SCHEDULED
          await tx.callAttempt.upsert({
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
              scheduledAt: nextAt,
              payload: { schedule_reason: outcome, hangup_on_voicemail: true },
            },
            update: { scheduledAt: nextAt },
          });

          await tx.lead.update({
            where: { id: lead.id },
            data: {
              status: "SCHEDULED",
              nextScheduledAt: nextAt,
            },
          });
        }
      });

      // done with structured branch
      return res.json({ ok: true });
    }

    // -------------------- Flat legacy payload --------------------
    const statusMap = {
      answered: "ANSWERED",
      voicemail: "VOICEMAIL",
      "no-answer": "NO_ANSWER",
      no_answer: "NO_ANSWER",
      noanswer: "NO_ANSWER",
      failed: "FAILED",
    };
    outcome = statusMap[String(body.outcome || "").toLowerCase()] || "FAILED";

    conversationId = body.conversation_id || body.id || null;
    const leadId = Number(body?.metadata?.lead_id) || null;
    emailFromMeta = body?.metadata?.email || null;
    startedAt = body?.started_at ? new Date(body.started_at) : null;
    endedAt = body?.ended_at ? new Date(body.ended_at) : new Date();
    recordingUrl = body?.recording_url || null;

    transcriptArr = Array.isArray(body?.transcript) ? body.transcript : null;
    transcriptStr = transcriptArr
      ? JSON.stringify(transcriptArr)
      : typeof body?.transcript === "string"
      ? body.transcript
      : null;
    if (transcriptStr && transcriptStr.length > 500_000) {
      transcriptStr = transcriptStr.slice(0, 500_000);
    }

    const lead = leadId
      ? await prisma.lead.findUnique({ where: { id: leadId } })
      : null;
    if (!lead) {
      console.warn("[WEBHOOK] lead not found (flat)", {
        leadId,
        conversationId,
      });
      return res.status(200).json({ ok: true, note: "lead_not_found" });
    }

    await prisma.$transaction(async (tx) => {
      const got = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(${BigInt(
        lead.id
      )}) AS ok;`;
      if (!got?.[0]?.ok) return; // someone else is processing

      // try exact match by conversationExternalId first
      let attempt = conversationId
        ? await tx.callAttempt.findFirst({
            where: { leadId: lead.id, conversationExternalId: conversationId },
            orderBy: { attemptNumber: "desc" },
          })
        : null;

      // else use the due SCHEDULED attempt
      if (!attempt) {
        attempt = await tx.callAttempt.findFirst({
          where: {
            leadId: lead.id,
            status: "SCHEDULED",
            scheduledAt: { lte: new Date() },
          },
          orderBy: [{ attemptNumber: "desc" }, { scheduledAt: "desc" }],
        });
      }

      if (!attempt) {
        // create a minimal terminal attempt to capture the event
        await tx.callAttempt.create({
          data: {
            leadId: lead.id,
            attemptNumber: (lead.attempts ?? 0) + 1,
            status: outcome,
            scheduledAt: startedAt || new Date(),
            startedAt: startedAt || null,
            endedAt: endedAt || new Date(),
            conversationId: conversationId || null,
            conversationExternalId: conversationId || null,
            recordingUrl: recordingUrl || null,
            transcript: transcriptStr || null,
            payload: body,
          },
        });
      } else {
        if (
          attempt.conversationExternalId === conversationId &&
          ["ANSWERED", "VOICEMAIL", "NO_ANSWER", "FAILED", "CANCELED"].includes(
            attempt.status
          )
        ) {
          return; // idempotent duplicate
        }
        await tx.callAttempt.update({
          where: { id: attempt.id },
          data: {
            status: outcome,
            startedAt: startedAt || attempt.startedAt,
            endedAt: endedAt || new Date(),
            conversationId: conversationId || attempt.conversationId,
            conversationExternalId:
              conversationId || attempt.conversationExternalId,
            recordingUrl: recordingUrl ?? attempt.recordingUrl ?? null,
            transcript: transcriptStr ?? attempt.transcript ?? null,
            payload: body,
          },
        });
      }

      // recompute attempts count
      const latest = await tx.callAttempt.findFirst({
        where: { leadId: lead.id },
        orderBy: { attemptNumber: "desc" },
        select: { attemptNumber: true },
      });
      const attemptsCount = latest?.attemptNumber ?? lead.attempts ?? 1;

      await tx.lead.update({
        where: { id: lead.id },
        data: {
          status: outcome,
          lastOutcome: outcome,
          lastAttemptAt: new Date(),
          attempts: attemptsCount,
        },
      });

      try {
        if (outcome === "NO_ANSWER") {
          await handleAttemptNotifications({
            lead,
            attemptNumber: attemptsCount,
            outcome,
          });
        }
      } catch (e) {
        console.warn(
          "[NOTIFY] attempt notifications failed (flat)",
          e?.message
        );
      }

      // schedule next attempt if allowed
      const maxAttempts = lead.maxAttempts ?? 3;
      const retryable = ["FAILED", "NO_ANSWER", "VOICEMAIL"];
      if (retryable.includes(outcome) && attemptsCount < maxAttempts) {
        const nextUnix = computeNextAttemptUnix(lead.timezone || QUEBEC_TZ);
        const nextAt = new Date(nextUnix * 1000);

        await tx.callAttempt.upsert({
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
            scheduledAt: nextAt,
            payload: { schedule_reason: outcome, hangup_on_voicemail: true },
          },
          update: { scheduledAt: nextAt },
        });

        await tx.lead.update({
          where: { id: lead.id },
          data: { status: "SCHEDULED", nextScheduledAt: nextAt },
        });
      }
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error("[WEBHOOK error]", e);
    // Ack to avoid provider retries looping; logs hold the error
    return res.status(200).json({ ok: true, note: "error_swallowed_for_el" });
  }
});

export default r;
