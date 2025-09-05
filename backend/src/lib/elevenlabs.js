import moment from "moment-timezone";
import fetch from "node-fetch";

import { START, END, QUEBEC_TZ } from "./quebecTime.js";
import { prisma } from "./prisma.js"; // Assuming prisma is imported for DB access

// Assuming prisma is imported for DB access

// Assuming prisma is imported for DB access

// ElevenLabs single outbound call endpoint
export const EL_API =
  "https://api.elevenlabs.io/v1/convai/twilio/outbound-call";

/**
 * Initiate an outbound call (single call) with optional forced webhook.
 * Accepts:
 *   to: E.164 phone (string, required)
 *   lead: { id (number), fullName (string), email (string|null), timezone (string), scheduledUnix (number|null), scheduledAt (Date|null) }
 *   attemptNumber: int (required, positive)
 *   variables: {} (dynamic variables for agent, optional)
 *   metadata: {} (additional metadata, optional)
 * @throws Error on invalid input, max attempts exceeded, or API failure
 */
export async function callOutbound({
  to,
  lead,
  attemptNumber,
  variables = {},
  metadata = {},
}) {
  // Input validation
  if (!to || typeof to !== "string" || !/^\+?[1-9]\d{1,14}$/.test(to)) {
    console.error("[SCHEDULE] Invalid phone number:", to);
    throw new Error(
      "Invalid or missing 'to' phone number. Must be E.164 format."
    );
  }
  if (!lead || typeof lead !== "object" || !Number.isInteger(lead.id)) {
    console.error("[SCHEDULE] Invalid lead:", lead);
    throw new Error("Invalid or missing lead object with valid id.");
  }
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
    console.error("[SCHEDULE] Invalid attemptNumber:", attemptNumber);
    throw new Error(
      "Invalid or missing attemptNumber. Must be a positive integer."
    );
  }
  if (typeof variables !== "object" || variables === null) {
    console.error("[SCHEDULE] Invalid variables:", variables);
    throw new Error("Variables must be an object.");
  }
  if (typeof metadata !== "object" || metadata === null) {
    console.error("[SCHEDULE] Invalid metadata:", metadata);
    throw new Error("Metadata must be an object.");
  }

  // Check for max attempts
  const MAX_ATTEMPTS = 3; // Consistent with webhook
  const maxAttempt = await prisma.callAttempt.findFirst({
    where: { leadId: lead.id },
    orderBy: { attemptNumber: "desc" },
  });
  const attemptsOnLead = maxAttempt?.attemptNumber ?? 0;
  if (attemptsOnLead >= MAX_ATTEMPTS) {
    console.warn(
      `[SCHEDULE] Max attempts (${MAX_ATTEMPTS}) reached for lead ${lead.id}, skipping`
    );
    throw new Error(
      `Max attempts (${MAX_ATTEMPTS}) reached for lead ${lead.id}`
    );
  }

  // Clean up excessive attempts
  const excessiveAttempts = await prisma.callAttempt.findMany({
    where: {
      leadId: lead.id,
      attemptNumber: { gt: MAX_ATTEMPTS },
    },
  });
  if (excessiveAttempts.length > 0) {
    await prisma.callAttempt.deleteMany({
      where: {
        leadId: lead.id,
        attemptNumber: { gt: MAX_ATTEMPTS },
      },
    });
    console.debug(
      `[SCHEDULE] Deleted ${excessiveAttempts.length} excessive attempts for lead ${lead.id}`
    );
  }

  // Validate environment variables
  if (
    !process.env.EL_AGENT_ID ||
    !process.env.EL_PHONE_ID ||
    !process.env.ELEVENLABS_API_KEY
  ) {
    console.error("[SCHEDULE] Missing required environment variables", {
      EL_AGENT_ID: !!process.env.EL_AGENT_ID,
      EL_PHONE_ID: !!process.env.EL_PHONE_ID,
      ELEVENLABS_API_KEY: !!process.env.ELEVENLABS_API_KEY,
    });
    throw new Error("Missing required ElevenLabs environment variables");
  }

  // Schedule time: prefer scheduledUnix, else scheduledAt, else now + RETRY_GAP_MINUTES
  const RETRY_GAP_MINUTES = 10;
  let scheduled_time_unix = lead.scheduledUnix;
  if (!scheduled_time_unix && lead.scheduledAt) {
    scheduled_time_unix = Math.floor(
      new Date(lead.scheduledAt).getTime() / 1000
    );
  }
  if (!scheduled_time_unix) {
    const tz = lead.timezone || QUEBEC_TZ;
    let nextM = moment()
      .tz(tz)
      .add(RETRY_GAP_MINUTES, "minutes")
      .second(0)
      .millisecond(0);
    const h = nextM.hour();
    const dow = nextM.day();
    if (dow === 0 || dow === 6 || h < START || h >= END) {
      console.debug(
        `[SCHEDULE] Time outside business hours (${START}:00-${END}:00), clamping`
      );
      const insideUnix = await nextInsideWindowUnix(tz);
      nextM = moment.unix(insideUnix).tz(tz);
    }
    scheduled_time_unix = Math.floor(nextM.toDate().getTime() / 1000);
  }
  if (
    !Number.isInteger(scheduled_time_unix) ||
    scheduled_time_unix < Math.floor(Date.now() / 1000)
  ) {
    console.error(
      "[SCHEDULE] Invalid scheduled_time_unix:",
      scheduled_time_unix
    );
    throw new Error(
      "Invalid scheduled_time_unix. Must be a future Unix timestamp."
    );
  }

  // Build request body with sanitized inputs
  const body = {
    agent_id: process.env.EL_AGENT_ID,
    agent_phone_number_id: process.env.EL_PHONE_ID,
    to_number: to,
    scheduled_time_unix,
    metadata: {
      lead_id: Number(lead.id), // Ensure number
      email: lead.email || null,
      attempt: Number(attemptNumber), // Ensure number
      timezone: lead.timezone || QUEBEC_TZ,
      ...sanitizeMetadata(metadata), // Sanitize metadata
    },
    variables: {
      email: lead.email || null,
      ...sanitizeVariables(variables), // Sanitize variables
    },
  };

  if (process.env.EL_WEBHOOK_ID) {
    body.post_call_webhook_id = process.env.EL_WEBHOOK_ID;
  }

  // Sanitize inputs to prevent injection
  function sanitizeMetadata(obj) {
    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof key !== "string" || key.length > 100) continue; // Limit key length
      if (typeof value === "string" && value.length <= 1000) {
        sanitized[key] = value.replace(/[<>"'&]/g, ""); // Remove dangerous chars
      } else if (
        typeof value === "number" ||
        typeof value === "boolean" ||
        value === null
      ) {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  function sanitizeVariables(obj) {
    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof key !== "string" || key.length > 100) continue;
      if (typeof value === "string" && value.length <= 1000) {
        sanitized[key] = value.replace(/[<>"'&]/g, "");
      } else if (
        typeof value === "number" ||
        typeof value === "boolean" ||
        value === null
      ) {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  // Make API call with retry logic
  let attempt = 0;
  const maxRetries = 3;
  let delay = 500;
  while (attempt < maxRetries) {
    try {
      console.debug(
        `[SCHEDULE] Sending outbound call request, attempt ${attempt + 1}`
      );
      const r = await fetch(EL_API, {
        method: "POST",
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
          "User-Agent": "LeadCaller/1.0", // Add User-Agent for tracking
        },
        body: JSON.stringify(body),
      });

      const txt = await r.text();
      if (!r.ok) {
        console.error("[SCHEDULE] EL outbound-call failed:", r.status, txt);
        throw new Error(`EL outbound-call failed: ${r.status} ${txt}`);
      }

      let resp = {};
      try {
        resp = JSON.parse(txt);
      } catch (e) {
        console.error("[SCHEDULE] Failed to parse EL response:", e.message);
        throw new Error("Invalid JSON response from ElevenLabs");
      }

      const conversation_id = resp.conversation_id || null;
      console.log("[EL] outbound scheduled", {
        to,
        scheduled_time_unix,
        attemptNumber,
        webhookId: process.env.EL_WEBHOOK_ID || null,
        conversation_id,
      });

      // Update database
      await prisma.callAttempt.create({
        data: {
          leadId: lead.id,
          attemptNumber,
          status: "SCHEDULED",
          scheduledAt: new Date(scheduled_time_unix * 1000),
          conversationId: conversation_id,
          payload: {
            webhookId: process.env.EL_WEBHOOK_ID,
            schedule_reason: "INITIAL",
          },
        },
      });
      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          status: "SCHEDULED",
          nextScheduledAt: new Date(scheduled_time_unix * 1000),
          attempts: attemptNumber,
        },
      });

      return { scheduled_time_unix, conversation_id };
    } catch (error) {
      attempt++;
      if (attempt >= maxRetries) {
        console.error("[SCHEDULE] All retries failed:", error.message);
        throw error;
      }
      console.debug(
        `[SCHEDULE] Retry ${attempt}/${maxRetries} after ${delay}ms`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }

  throw new Error("Failed to schedule outbound call after retries");
}
