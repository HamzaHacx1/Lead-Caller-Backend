// routes/webhooks.elevenlabs.js
import { Router } from "express";
import fetch from "node-fetch";
import crypto from "crypto";

const r = Router();

/** ---------- HMAC verify (ElevenLabs) ---------- */
function verifyHmac(req) {
  const secret = process.env.EL_WEBHOOK_SECRET || "";
  const header = req.headers["elevenlabs-signature"] || "";
  const rawBody = req.rawBody;
  if (!secret || !header || !rawBody) return false;

  // header example: "t=1699999999, v0=sha256=ABCDEF..."
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

  // accept ±30 min clock skew
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(t, 10);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 30 * 60) return false;

  const payload = `${t}.${rawBody.toString("utf8")}`;
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

/** ---------- tiny helpers ---------- */
function normPhone(p) {
  if (!p) return null;
  const digits = String(p).replace(/[^\d+0-9]/g, "");
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

/** ---------- POST to external backend (with simple retries) ---------- */
async function postToCRM(payload) {
  const url = process.env.CRM_ENDPOINT;
  if (!url) {
    console.warn("[CRM] CRM_ENDPOINT not set; skipping post");
    return;
  }
  const headers = { "Content-Type": "application/json" };
  let attempt = 0,
    delay = 600;
  while (attempt < 3) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      if (res.ok) return;
      const txt = await res.text().catch(() => "");
      console.warn(`[CRM] post failed ${res.status}`, txt?.slice(0, 200));
    } catch (e) {
      console.warn("[CRM] error", e?.message);
    }
    attempt++;
    await new Promise((r) => setTimeout(r, delay));
    delay *= 2;
  }
}

/** ------------------------------------------------------------------
 *  Webhook: DB-FREE — authenticate, normalize, forward to CRM
 *  Accepts:
 *   - New style: { type: "post_call_transcription", data: {...} }
 *   - Old/flat style for backward compatibility
 *  Responds 200 quickly (EL expects 2xx).
 * ------------------------------------------------------------------*/
r.post("/elevenlabs", async (req, res) => {
  try {
    const disableAuth = process.env.DISABLE_WEBHOOK_AUTH === "1";
    const debugBypass =
      (req.headers["x-debug-pass"] || "") === (process.env.API_KEY || "");
    const hasValidHmac = verifyHmac(req);
    const staticOk =
      (req.headers["x-webhook-secret"] || "") ===
      (process.env.EL_WEBHOOK_SECRET || "");

    if (!disableAuth && !debugBypass && !hasValidHmac && !staticOk) {
      // Return 200 to avoid EL retries/noise, but do nothing.
      return res
        .status(200)
        .json({ ok: true, note: "invalid_signature_ignored" });
    }

    const body =
      req.body && typeof req.body === "string"
        ? JSON.parse(req.body) // if raw body slipped through as string
        : req.body || {};

    let crmPayload = null;

    /** ---------- New structured payload ---------- */
    if (body.type === "post_call_transcription" && body.data) {
      const d = body.data;

      const outcome = mapOutcomeFromTranscription(d);
      const meta = d.metadata || {};
      const pc = meta.phone_call || {};

      // Numbers as seen by EL
      const from_number = normPhone(
        pc.external_number ||
          meta.from_number ||
          meta.caller_number ||
          meta.user_number
      );
      const to_number = normPhone(
        pc.agent_number ||
          meta.to_number ||
          meta.phone_number ||
          meta.agent_number
      );

      // Dynamic variables (from your /calls/outbound -> callOutbound)
      const dyn =
        d.conversation_initiation_client_data?.dynamic_variables || {};
      const leadId = Number(dyn.lead_id) || Number(meta.lead_id) || null;
      const email = meta.email || dyn.lead_email || null;
      const fullName = dyn.lead_full_name || meta.full_name || null;
      const phoneGuess =
        normPhone(dyn.lead_phone) || from_number || meta.caller_number || null;

      const transcriptArr = Array.isArray(d.transcript) ? d.transcript : null;
      let transcriptStr = transcriptArr ? JSON.stringify(transcriptArr) : null;
      if (transcriptStr && transcriptStr.length > 500_000) {
        transcriptStr = transcriptStr.slice(0, 500_000);
      }

      const startedAt = meta.started_at ? new Date(meta.started_at) : null;
      const endedAt = meta.ended_at ? new Date(meta.ended_at) : new Date();

      const dc = pickDataCollections(d);

      crmPayload = {
        // === Core identity/context ===
        leadId: leadId, // try to always pass this through from your outbound call
        fullName: fullName,
        phone: phoneGuess,
        email: email || null,

        // === Outcome & call meta ===
        outcome,
        conversationId:
          d.conversation_id || body.conversation_id || body.id || null,
        startedAt: startedAt ? startedAt.toISOString() : null,
        endedAt: endedAt ? endedAt.toISOString() : null,
        durationSecs: Number(meta.call_duration_secs ?? null),
        costCents: Number(meta.cost ?? null),
        terminationReason: meta.termination_reason || null,

        // === Summaries & collections ===
        summary: d.analysis?.transcript_summary || null,
        summaryTitle: d.analysis?.call_summary_title || null,
        availability: dc.availability,
        job_status: dc.job_status,
        salary_expectations: dc.salary_expectations,
        job_type: dc.job_type,
        job_field: dc.job_field,
        dataCollectionsRaw: d?.analysis?.data_collection_results || {},

        // === Transcript & raw ===
        transcript: transcriptArr || [],
        raw: body,
      };
    } else {
      /** ---------- Old/flat payload fallback ---------- */
      const statusMap = {
        answered: "ANSWERED",
        voicemail: "VOICEMAIL",
        "no-answer": "NO_ANSWER",
        no_answer: "NO_ANSWER",
        noanswer: "NO_ANSWER",
        failed: "FAILED",
      };
      const rawOutcome = String(body.outcome || "").toLowerCase();
      const outcome = statusMap[rawOutcome] || "FAILED";

      const leadId = Number(body?.metadata?.lead_id) || null;
      const email = body?.metadata?.email || null;
      const fullName = body?.metadata?.full_name || null;
      const phone = normPhone(body?.metadata?.lead_phone || body?.from_number);

      const transcriptArr = Array.isArray(body?.transcript)
        ? body.transcript
        : null;
      let transcriptStr = transcriptArr
        ? JSON.stringify(transcriptArr)
        : typeof body?.transcript === "string"
        ? body.transcript
        : null;
      if (transcriptStr && transcriptStr.length > 500_000) {
        transcriptStr = transcriptStr.slice(0, 500_000);
      }

      const startedAt = body?.started_at ? new Date(body.started_at) : null;
      const endedAt = body?.ended_at ? new Date(body.ended_at) : new Date();

      const dc = body?.analysis?.data_collection_results;
      const getDC = (key) => {
        if (!dc) return null;
        if (Array.isArray(dc)) {
          return (
            dc.find((i) => i?.key === key || i?.name === key)?.value ?? null
          );
        }
        if (typeof dc === "object") {
          return dc[key]?.value ?? dc[key] ?? null;
        }
        return null;
      };

      crmPayload = {
        leadId,
        fullName,
        phone,
        email,
        outcome,
        conversationId: body.conversation_id || body.id || null,
        startedAt: startedAt ? startedAt.toISOString() : null,
        endedAt: endedAt ? endedAt.toISOString() : null,
        durationSecs: Number(body?.call_duration_secs ?? null),
        costCents: Number(body?.cost ?? null),
        terminationReason: body?.termination_reason || null,
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
      };
    }

    // Fire-and-forget to your CRM; do not block response.
    postToCRM(crmPayload).catch(() => {});

    // Always respond 200 to keep EL happy
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[EL webhook] error:", e);
    // Still return 200 to avoid EL retries; include a note for logs
    return res.status(200).json({ ok: true, note: "error_swallowed_for_el" });
  }
});

export default r;
