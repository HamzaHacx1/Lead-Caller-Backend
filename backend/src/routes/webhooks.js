import moment from "moment-timezone";
import { Router } from "express";
import fetch from "node-fetch";
import crypto from "crypto";

import { nextInsideWindowUnix, START, END, pickTz } from "../lib/schedule.js";
import { handleQuickAttemptNotifications } from "../lib/notifications.js";
import { nowIn, QUEBEC_TZ } from "../lib/quebecTime.js";
import prisma from "../lib/prisma.js";

// ---- dialing policy (tweak for prod/testing) ----
const MAX_ATTEMPTS = 3; // total attempts per lead
const RETRY_GAP_MINUTES = 3; // gap between attempts for distinct nudges
const FINAL_STATUSES = new Set([
  "ANSWERED",
  "NO_ANSWER",
  "VOICEMAIL",
  "FAILED",
]);

const r = Router();

/** ---------- HMAC verify ---------- */
function verifyHmac(req) {
  const secret = process.env.EL_WEBHOOK_SECRET || "";
  const header = req.headers["elevenlabs-signature"] || "";

  if (!secret || !header || !req.rawBody) {
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

  if (!t || !v0) {
    return false;
  }

  if (v0.startsWith("sha256=")) v0 = v0.slice("sha256=".length);
  v0 = v0.trim().toLowerCase();

  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(t, 10);

  if (!Number.isFinite(ts) || Math.abs(now - ts) > 30 * 60) {
    return false;
  }

  const payload = `${t}.${req.rawBody.toString("utf8")}`;
  const hex = crypto.createHmac("sha256", secret).update(payload).digest("hex");

  try {
    const isValid = crypto.timingSafeEqual(
      Buffer.from(hex, "hex"),
      Buffer.from(v0, "hex")
    );
    return isValid;
  } catch (e) {
    return false;
  }
}

/** ---------- utils ---------- */
function normPhone(p) {
  if (!p) {
    return null;
  }
  const digits = String(p).replace(/[^\d+]/g, "");

  if (digits.startsWith("+")) {
    return digits;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  return digits;
}

function mapOutcomeFromTranscription(data) {
  const cs = data.analysis?.call_successful;
  const success =
    cs === true ||
    String(cs).toLowerCase() === "true" ||
    String(cs).toLowerCase() === "success";
  const term = String(data.metadata?.termination_reason || "").toLowerCase();

  if (success) {
    return "ANSWERED";
  }
  if (term.includes("voicemail")) {
    return "VOICEMAIL";
  }
  if (
    term.includes("no_answer") ||
    term.includes("no-answer") ||
    term.includes("noanswer") ||
    term.includes("silence") ||
    term.includes("busy")
  ) {
    return "NO_ANSWER";
  }
  if (
    term.includes("carrier_error") ||
    term.includes("error") ||
    term.includes("failed")
  ) {
    return "FAILED";
  }
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

/** ---------- POST to external backend (3 tries) ---------- */
async function postToExternal(payload) {
  const url = process.env.CRM_ENDPOINT;
  if (!url) {
    return;
  }

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

    if (!disableAuth && !debugBypass && !hasValidHmac && !staticOk) {
      return res
        .status(200)
        .json({ ok: true, note: "invalid_signature_ignored_for_debug" });
    }

    const body = req.body || {};
    let outcome = "FAILED";
    let convoId = body.conversation_id || body.id || null;

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
      const d = body.data;
      outcome = mapOutcomeFromTranscription(d);

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

      const dyn =
        d.conversation_initiation_client_data?.dynamic_variables || {};
      const sysCalled = dyn.system__called_number || null;
      const sysCaller = dyn.system__caller_id || null;

      const candidateLeadPhones = [from_number, sysCaller, m.caller_number]
        .map(normPhone)
        .filter(Boolean);

      from_number = normPhone(from_number) || normPhone(sysCaller);
      to_number = normPhone(to_number) || normPhone(sysCalled);

      emailFromMeta = m.email || null;
      leadId = Number(dyn.lead_id) || Number(m.lead_id) || null;

      startedAt = m.started_at ? new Date(m.started_at) : null;
      endedAt = m.ended_at ? new Date(m.ended_at) : new Date();

      transcriptArr = Array.isArray(d.transcript) ? d.transcript : null;
      transcriptStr = transcriptArr ? JSON.stringify(transcriptArr) : null;
      if (transcriptStr && transcriptStr.length > 500_000) {
        transcriptStr = transcriptStr.slice(0, 500_000);
      }

      recordingUrl = d.recording_url || d.audio_url || null;

      costCents = Number(m.cost ?? null);
      durationSecs = Number(m.call_duration_secs ?? null);
      summary = d.analysis?.transcript_summary || null;
      title = d.analysis?.call_summary_title || null;
      termination = m.termination_reason || null;

      const dc = pickDataCollections(d);
      const dataCollectionsRaw = d?.analysis?.data_collection_results || {};

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
          leadId,
          from_number,
          to_number,
          sysCalled,
          sysCaller,
        });
        return res.status(200).json({ ok: true, note: "lead_not_found" });
      }

      if (emailFromMeta && (!lead.email || lead.email !== emailFromMeta)) {
        await prisma.lead.update({
          where: { id: lead.id },
          data: { email: emailFromMeta },
        });
      }

      /** ---------- Update attempt & lead (IDEMPOTENT) ---------- */
      let attempt = null;
      if (convoId) {
        attempt = await prisma.callAttempt.findFirst({
          where: { leadId: lead.id, conversationId: convoId },
        });
      }

      if (!attempt) {
        const fortyFiveMinsAgo = new Date(Date.now() - 45 * 60 * 1000);
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
      }

      if (!attempt) {
        const last = await prisma.callAttempt.findFirst({
          where: { leadId: lead.id },
          orderBy: { attemptNumber: "desc" },
        });

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
        console.log("[WEBHOOK] Call initiated for new attempt", {
          leadId: lead.id,
          attemptNumber: attempt.attemptNumber,
          startedAt: attempt.startedAt.toISOString(),
        });
      }

      if (!FINAL_STATUSES.has(attempt.status)) {
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
      }

      const maxAttempt = await prisma.callAttempt.findFirst({
        where: { leadId: lead.id },
        orderBy: { attemptNumber: "desc" },
      });
      const currentAttemptNumber = attempt.attemptNumber;
      const attemptsOnLead = maxAttempt?.attemptNumber ?? currentAttemptNumber;

      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          status: outcome,
          lastOutcome: outcome,
          lastAttemptAt: new Date(),
          attempts: attemptsOnLead,
        },
      });

      try {
        if (["ANSWERED", "NO_ANSWER"].includes(outcome)) {
          await handleQuickAttemptNotifications({
            lead,
            attemptNumber: currentAttemptNumber,
            outcome,
          });
        }
      } catch (e) {
        console.warn("[NOTIFY] attempt notifications failed", e?.message);
      }

      /** ---------- Push to external backend ---------- */
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
      }).catch((e) => {});

      /** ---------- Retry (window-safe, idempotent, capped) ---------- */
      const retryable = ["FAILED", "NO_ANSWER", "VOICEMAIL"];
      if (retryable.includes(outcome) && attemptsOnLead < MAX_ATTEMPTS) {
        const nextAttemptExists = await prisma.callAttempt.findUnique({
          where: {
            leadId_attemptNumber: {
              leadId: lead.id,
              attemptNumber: currentAttemptNumber + 1,
            },
          },
          select: { id: true },
        });

        if (!nextAttemptExists) {
          const tz = pickTz(lead.timezone || QUEBEC_TZ);
          let nextM = moment()
            .tz(tz)
            .add(3, "minutes")
            .second(0)
            .millisecond(0);
          const scheduledAt = nextM.toDate();

          await prisma.callAttempt.create({
            data: {
              leadId: lead.id,
              attemptNumber: currentAttemptNumber + 1,
              status: "SCHEDULED",
              scheduledAt,
              payload: { schedule_reason: outcome, hangup_on_voicemail: true },
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

          console.log("[WEBHOOK] Next attempt scheduled", {
            leadId: lead.id,
            attemptNumber: currentAttemptNumber + 1,
            scheduledAt: scheduledAt.toISOString(),
            when_local: nextM.format("YYYY-MM-DD HH:mm:ss z"),
          });
        }
      }

      console.log("[WEBHOOK] processed (structured):", {
        leadId: lead.id,
        outcome,
        from_number,
        to_number,
        attempts: attemptsOnLead,
      });
      return res.json({ ok: true });
    }

    /** ---------- Fallback: flat payloads ---------- */
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
    if (transcriptStr && transcriptStr.length > 500_000) {
      transcriptStr = transcriptStr.slice(0, 500_000);
    }

    recordingUrl = body?.recording_url || null;
    startedAt = body?.started_at ? new Date(body.started_at) : null;
    endedAt = body?.ended_at ? new Date(body.ended_at) : new Date();

    let lead = null;
    if (leadId) {
      lead = await prisma.lead.findUnique({ where: { id: leadId } });
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

    const maxAttempt = await prisma.callAttempt.findFirst({
      where: { leadId: lead.id },
      orderBy: { attemptNumber: "desc" },
    });
    const attemptsCount = maxAttempt?.attemptNumber ?? 0;

    if (attemptsCount >= MAX_ATTEMPTS) {
      console.warn(
        `[WEBHOOK] Max attempts (${MAX_ATTEMPTS}) reached for lead ${lead.id}, no further retries scheduled`
      );
    } else {
      const newAttempt = await prisma.callAttempt.upsert({
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

      console.log("[WEBHOOK] Call initiated for new attempt (flat)", {
        leadId: lead.id,
        attemptNumber: newAttempt.attemptNumber,
        startedAt: newAttempt.startedAt?.toISOString() || null,
      });

      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          status: outcome,
          lastOutcome: outcome,
          lastAttemptAt: new Date(),
          attempts: attemptsCount + 1,
        },
      });
    }

    try {
      if (outcome === "NO_ANSWER") {
        await handleQuickAttemptNotifications({
          lead,
          attemptNumber: attemptsCount + 1,
          outcome,
        });
      }
    } catch (e) {
      console.warn("[NOTIFY] attempt notifications failed (flat)", e?.message);
    }

    const dc = body?.analysis?.data_collection_results;
    function getDC(key) {
      if (!dc) {
        return null;
      }
      if (Array.isArray(dc)) {
        return dc.find((i) => i?.key === key || i?.name === key)?.value ?? null;
      }
      if (typeof dc === "object") {
        return dc[key]?.value ?? dc[key] ?? null;
      }
      return null;
    }

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
    }).catch((e) => {});

    if (
      ["FAILED", "NO_ANSWER", "VOICEMAIL"].includes(outcome) &&
      attemptsCount < MAX_ATTEMPTS
    ) {
      const nextAttemptExists = await prisma.callAttempt.findUnique({
        where: {
          leadId_attemptNumber: {
            leadId: lead.id,
            attemptNumber: attemptsCount + 1,
          },
        },
        select: { id: true },
      });

      if (!nextAttemptExists) {
        const tz = pickTz(lead.timezone || QUEBEC_TZ);
        let nextM = moment().tz(tz).add(3, "minutes").second(0).millisecond(0);
        const scheduledAt = nextM.toDate();

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
            status: "SCHEDULED",
            scheduledAt,
            payload: { schedule_reason: outcome, hangup_on_voicemail: true },
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

        console.log("[WEBHOOK] Next attempt scheduled (flat)", {
          leadId: lead.id,
          attemptNumber: attemptsCount + 1,
          scheduledAt: scheduledAt.toISOString(),
          when_local: nextM.format("YYYY-MM-DD HH:mm:ss z"),
        });
      }
    }

    console.log("[WEBHOOK] processed (flat):", {
      leadId: lead.id,
      outcome,
      attempts: attemptsCount,
    });
    return res.json({ ok: true });
  } catch (e) {
    console.error("[WEBHOOK error]", e);
    return res.status(200).json({ ok: true, note: "error_swallowed_for_el" });
  }
});

export default r;
