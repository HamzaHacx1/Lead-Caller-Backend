import { PrismaClient } from "@prisma/client";
import { Router } from "express";
import fetch from "node-fetch";
import crypto from "crypto";

import { nextInsideWindowUnix } from "../lib/schedule.js";
import { callOutbound } from "../lib/elevenlabs.js";

const prisma = new PrismaClient();
const r = Router();

/** ---------- HMAC verify ---------- */
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
    return crypto.timingSafeEqual(Buffer.from(hex), Buffer.from(v0));
  } catch {
    return false;
  }
}

/** ---------- utils ---------- */
function normPhone(p) {
  if (!p) return null;
  const digits = String(p).replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return digits;
}

function mapOutcomeFromTranscription(data) {
  const success = String(data.analysis?.call_successful || "").toLowerCase();
  const term = String(data.metadata?.termination_reason || "").toLowerCase();

  if (success === "success") return "ANSWERED";
  if (term.includes("voicemail")) return "VOICEMAIL";
  if (
    term.includes("no_answer") ||
    term.includes("no-answer") ||
    term.includes("noanswer") ||
    term.includes("silence")
  )
    return "NO_ANSWER";
  if (term.includes("busy")) return "NO_ANSWER";
  if (
    term.includes("carrier_error") ||
    term.includes("error") ||
    term.includes("failed")
  )
    return "FAILED";
  return "FAILED";
}

/** pull structured fields from analysis.data_collection_results */
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

/** ---------- POST to your external backend (3 tries) ---------- */
async function postToExternal(payload) {
  const url = process.env.CRM_ENDPOINT;
  if (!url) return; // silently skip if not configured

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
      if (res.ok) {
        console.log("[CRM] posted ok");
        return;
      }
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

/** ---------- Route ---------- */
r.post("/elevenlabs", async (req, res) => {
  try {
    console.log(
      "[WEBHOOK] sig:",
      req.headers["elevenlabs-signature"],
      "rawLen:",
      req.rawBody?.length,
      "type:",
      req.body?.type
    );

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

    if (!disableAuth && !debugBypass && !hasValidHmac && !staticOk) {
      return res
        .status(200)
        .json({ ok: true, note: "invalid_signature_ignored_for_debug" });
    }

    const body = req.body || {};
    let outcome = "FAILED";
    let convoId = body.conversation_id || body.id || null;

    let transcriptArr = null; // array from EL
    let transcriptStr = null; // stringified for DB
    let recordingUrl = null;
    let startedAt = null;
    let endedAt = null;

    let leadId = null;
    let emailFromMeta = null;
    let from_number = null;
    let to_number = null;

    // extras for CRM
    let costCents = null;
    let durationSecs = null;
    let summary = null;
    let title = null;
    let termination = null;

    if (body.type === "post_call_transcription" && body.data) {
      const d = body.data;
      outcome = mapOutcomeFromTranscription(d);

      const m = d.metadata || {};
      const pc = m.phone_call || {};

      // numbers
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

      const dyn =
        d.conversation_initiation_client_data?.dynamic_variables || {};
      const sysCalled = dyn.system__called_number || null;
      const sysCaller = dyn.system__caller_id || null;

      const candidateLeadPhones = [
        from_number,
        sysCalled,
        m.to_number,
        m.phone_number,
      ]
        .map(normPhone)
        .filter(Boolean);

      from_number = normPhone(from_number) || normPhone(sysCaller);
      to_number = normPhone(to_number) || normPhone(sysCalled);

      emailFromMeta = m.email || null;
      leadId = Number(dyn.lead_id) || Number(m.lead_id) || null;

      // timing + transcript
      startedAt = m.started_at ? new Date(m.started_at) : null;
      endedAt = m.ended_at ? new Date(m.ended_at) : new Date();
      transcriptArr = Array.isArray(d.transcript) ? d.transcript : null;
      transcriptStr = transcriptArr ? JSON.stringify(transcriptArr) : null;
      recordingUrl = d.recording_url || d.audio_url || null;

      // extras for CRM
      costCents = Number(m.cost ?? null);
      durationSecs = Number(m.call_duration_secs ?? null);
      summary = d.analysis?.transcript_summary || null;
      title = d.analysis?.call_summary_title || null;
      termination = m.termination_reason || null;

      // NEW: structured extractions
      const dc = pickDataCollections(d);

      /** ---------- Lead matching ---------- */
      let lead = null;
      if (leadId) {
        lead = await prisma.lead.findUnique({ where: { id: leadId } });
      }
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
      if (!lead && to_number) {
        lead = await prisma.lead.findFirst({
          where: { phone: to_number },
          orderBy: { createdAt: "desc" },
        });
      }
      if (!lead && process.env.AUTO_CREATE_LEAD_FROM_WEBHOOK === "1") {
        const tz = process.env.DEFAULT_TZ || "UTC";
        const phoneGuess = candidateLeadPhones[0] || from_number || to_number;
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
          leadId,
          from_number,
          to_number,
          sysCalled,
          sysCaller,
        });
        return res.status(200).json({ ok: true, note: "lead_not_found" });
      }

      // enrich email if provided
      if (emailFromMeta && (!lead.email || lead.email !== emailFromMeta)) {
        await prisma.lead.update({
          where: { id: lead.id },
          data: { email: emailFromMeta },
        });
      }

      /** ---------- Update attempt & lead (STRINGIFY transcript) ---------- */
      let attempt = await prisma.callAttempt.findFirst({
        where: { leadId: lead.id },
        orderBy: { createdAt: "desc" },
      });
      if (!attempt) {
        attempt = await prisma.callAttempt.create({
          data: {
            leadId: lead.id,
            attemptNumber: (lead.attempts || 0) + 1,
            status: "SCHEDULED",
            scheduledAt: new Date(),
          },
        });
      }

      await prisma.callAttempt.update({
        where: { id: attempt.id },
        data: {
          status: outcome,
          startedAt: startedAt || attempt.startedAt,
          endedAt: endedAt || new Date(),
          conversationId:
            d.conversation_id || convoId || attempt.conversationId,
          recordingUrl: recordingUrl || attempt.recordingUrl || null,
          transcript: transcriptStr ?? attempt.transcript ?? null,
          payload: body,
        },
      });

      const attemptsCount = (lead.attempts || 0) + 1;
      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          status: outcome,
          lastOutcome: outcome,
          lastAttemptAt: new Date(),
          attempts: attemptsCount,
        },
      });

      /** ---------- Push to your external backend ---------- */
      const crmPayload = {
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

        // NEW: structured fields
        availability: dc.availability,
        job_status: dc.job_status,
        salary_expectations: dc.salary_expectations,
        job_type: dc.job_type,
        job_field: dc.job_field,

        transcript: transcriptArr || [],
        raw: body,
      };
      postToExternal(crmPayload).catch(() => {});

      /** ---------- Retry only on FAILED ---------- */
      if (outcome === "FAILED" && attemptsCount < 3) {
        const scheduledUnix = nextInsideWindowUnix(lead.timezone);
        const newAttempt = await prisma.callAttempt.create({
          data: {
            leadId: lead.id,
            attemptNumber: attemptsCount + 1,
            status: "SCHEDULED",
            scheduledAt: new Date(scheduledUnix * 1000),
          },
        });
        const { conversation_id } = await callOutbound({
          to: candidateLeadPhones[0] || from_number || to_number || lead.phone,
          lead: { ...lead, scheduledUnix },
          attemptNumber: attemptsCount + 1,
          variables: {},
        });
        if (conversation_id) {
          await prisma.callAttempt.update({
            where: { id: newAttempt.id },
            data: { conversationId: conversation_id },
          });
        }
      }

      console.log("[WEBHOOK] processed:", {
        leadId: lead.id,
        outcome,
        from_number,
        to_number,
        attempts: attemptsCount,
      });
      return res.json({ ok: true });
    }

    /** ---------- Fallback: old flat payloads ---------- */
    const statusMap = {
      answered: "ANSWERED",
      voicemail: "VOICEMAIL",
      "no-answer": "NO_ANSWER",
      no_answer: "NO_ANSWER",
      noanswer: "NO_ANSWER",
      failed: "FAILED",
    };
    const rawOutcome = String(body.outcome || "").toLowerCase();
    outcome = statusMap[rawOutcome] || "FAILED";
    to_number = normPhone(body.to_number || body.phone_number || null);
    leadId = Number(body?.metadata?.lead_id) || null;
    emailFromMeta = body?.metadata?.email || null;
    transcriptArr = Array.isArray(body?.transcript) ? body.transcript : null;
    transcriptStr = transcriptArr
      ? JSON.stringify(transcriptArr)
      : typeof body?.transcript === "string"
      ? body.transcript
      : null;
    recordingUrl = body?.recording_url || null;
    startedAt = body?.started_at ? new Date(body.started_at) : null;
    endedAt = body?.ended_at ? new Date(body.ended_at) : new Date();

    let lead = null;
    if (leadId) lead = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead && to_number) {
      lead = await prisma.lead.findFirst({
        where: { phone: to_number },
        orderBy: { createdAt: "desc" },
      });
    }
    if (!lead) {
      console.warn("[WEBHOOK] lead not found (flat)", { leadId, to_number });
      return res.status(200).json({ ok: true, note: "lead_not_found" });
    }

    if (emailFromMeta && (!lead.email || lead.email !== emailFromMeta)) {
      await prisma.lead.update({
        where: { id: lead.id },
        data: { email: emailFromMeta },
      });
    }

    let attempt = await prisma.callAttempt.findFirst({
      where: { leadId: lead.id },
      orderBy: { createdAt: "desc" },
    });
    if (!attempt) {
      attempt = await prisma.callAttempt.create({
        data: {
          leadId: lead.id,
          attemptNumber: (lead.attempts || 0) + 1,
          status: "SCHEDULED",
          scheduledAt: new Date(),
        },
      });
    }

    await prisma.callAttempt.update({
      where: { id: attempt.id },
      data: {
        status: outcome,
        startedAt: startedAt || attempt.startedAt,
        endedAt: endedAt || new Date(),
        conversationId:
          body.conversation_id || body.id || attempt.conversationId,
        recordingUrl: recordingUrl || attempt.recordingUrl || null,
        transcript: transcriptStr ?? attempt.transcript ?? null,
        payload: body,
      },
    });

    const attemptsCount = (lead.attempts || 0) + 1;
    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        status: outcome,
        lastOutcome: outcome,
        lastAttemptAt: new Date(),
        attempts: attemptsCount,
      },
    });

    // Flat payloads don't include data_collection_results; send nulls
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
      summary: null,
      summaryTitle: null,
      availability: null,
      job_status: null,
      salary_expectations: null,
      job_type: null,
      job_field: null,
      transcript:
        transcriptArr ||
        (typeof body?.transcript === "string" ? body.transcript : null),
      raw: body,
    }).catch(() => {});

    if (outcome === "FAILED" && attemptsCount < 3) {
      const scheduledUnix = nextInsideWindowUnix(lead.timezone);
      await prisma.callAttempt.create({
        data: {
          leadId: lead.id,
          attemptNumber: attemptsCount + 1,
          status: "SCHEDULED",
          scheduledAt: new Date(scheduledUnix * 1000),
        },
      });
      await callOutbound({
        to: to_number || lead.phone,
        lead: { ...lead, scheduledUnix },
        attemptNumber: attemptsCount + 1,
        variables: {},
      });
    }

    console.log("[WEBHOOK] processed (flat):", {
      leadId: lead.id,
      outcome,
      attempts: attemptsCount,
    });
    return res.json({ ok: true });
  } catch (e) {
    console.error("Webhook error:", e);
    return res.status(200).json({ ok: true, note: "error_swallowed_for_el" });
  }
});

export default r;
