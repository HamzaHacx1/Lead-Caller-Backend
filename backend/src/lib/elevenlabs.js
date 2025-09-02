import fetch from "node-fetch";

// ElevenLabs single outbound call endpoint
export const EL_API =
  "https://api.elevenlabs.io/v1/convai/twilio/outbound-call";

/**
 * Initiate an outbound call (single call) with optional forced webhook.
 * Accepts:
 *   to: E.164 phone
 *   lead: { id, fullName, email, timezone, scheduledUnix }
 *   attemptNumber: int
 *   variables: {} (dynamic variables for your agent)
 */
// ...imports unchanged...

export async function callOutbound({
  to,
  lead,
  attemptNumber,
  variables = {},
  metadata = {},
}) {
  // Prefer provided scheduledUnix, else convert scheduledAt Date → unix
  const scheduled_time_unix =
    lead.scheduledUnix ??
    (lead.scheduledAt
      ? Math.floor(new Date(lead.scheduledAt).getTime() / 1000)
      : null);

  const body = {
    agent_id: process.env.EL_AGENT_ID,
    agent_phone_number_id: process.env.EL_PHONE_ID,
    to_number: to,
    scheduled_time_unix,
    metadata: {
      lead_id: lead.id,
      email: lead.email || null,
      attempt: attemptNumber,
      timezone: lead.timezone,
      ...metadata,
    },
    variables: {
      email: lead.email || null,
      ...variables,
    },
  };

  if (process.env.EL_WEBHOOK_ID) {
    body.post_call_webhook_id = process.env.EL_WEBHOOK_ID;
  }

  const r = await fetch(EL_API, {
    method: "POST",
    headers: {
      "xi-api-key": process.env.ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const txt = await r.text();
  if (!r.ok) {
    console.error("EL outbound-call failed:", r.status, txt);
    throw new Error(`EL outbound-call failed: ${r.status} ${txt}`);
  }

  let resp = {};
  try {
    resp = JSON.parse(txt);
  } catch {}
  const conversation_id = resp.conversation_id || null;

  console.log("[EL] outbound scheduled", {
    to,
    scheduled_time_unix,
    attemptNumber,
    webhookId: process.env.EL_WEBHOOK_ID || null,
    conversation_id,
  });

  return { scheduled_time_unix, conversation_id };
}
