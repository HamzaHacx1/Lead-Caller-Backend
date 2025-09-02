import { PrismaClient } from "@prisma/client";
// routes/calls.js
import { Router } from "express";

import { callOutbound } from "../lib/elevenlabs.js"; // your code above

// your code above

// your code above

// your code above

// your code above

const prisma = new PrismaClient();
const r = Router();

function requireBearer(req, res, next) {
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
  if (!token || token !== process.env.N8N_SHARED_SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

/**
 * POST /api/calls/outbound
 * Body:
 * {
 *   "to": "+15145550123",
 *   "lead": {
 *     "id": 123,
 *     "fullName": "Jane Doe",
 *     "email": "jane@example.com",
 *     "timezone": "America/Toronto",
 *     "scheduledUnix": 1725268200,   // optional
 *     "scheduledAt": "2025-09-02T16:30:00-04:00" // optional (ISO)
 *   },
 *   "attemptNumber": 1,
 *   "variables": { "booking_url": "..." },     // optional
 *   "metadata": { "source": "fb_lead_ads" }    // optional
 * }
 */
r.post("/calls/outbound", async (req, res) => {
  try {
    const {
      to,
      lead,
      attemptNumber,
      variables = {},
      metadata = {},
    } = req.body || {};

    // Minimal validation
    if (
      !to ||
      !lead?.id ||
      !lead?.timezone ||
      !Number.isInteger(attemptNumber)
    ) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing required fields" });
    }

    // (Optional) create a CallAttempt row up-front
    let callAttempt;
    try {
      callAttempt = await prisma.callAttempt.create({
        data: {
          leadId: lead.id,
          provider: "ELEVENLABS",
          status: "PLACED",
          attemptNumber,
          meta: metadata,
          startedAt: new Date(),
        },
      });
    } catch (e) {
      console.warn(
        "[CallAttempt create] failed; continuing anyway:",
        e?.message
      );
    }

    // Trigger ElevenLabs
    const { scheduled_time_unix, conversation_id } = await callOutbound({
      to,
      lead,
      attemptNumber,
      variables,
      metadata: {
        ...metadata,
        callAttemptId: callAttempt?.id ?? null,
      },
    });

    // (Optional) update the attempt with scheduled & conversation id
    if (callAttempt?.id) {
      await prisma.callAttempt.update({
        where: { id: callAttempt.id },
        data: {
          status: "SCHEDULED",
          meta: {
            ...(callAttempt.meta ?? {}),
            conversation_id,
          },
          // Store scheduled time (as ms)
          scheduledAt: scheduled_time_unix
            ? new Date(scheduled_time_unix * 1000)
            : null,
        },
      });
    }

    return res.json({
      ok: true,
      conversation_id,
      scheduled_time_unix,
      call_attempt_id: callAttempt?.id ?? null,
    });
  } catch (err) {
    console.error("[/calls/outbound] error:", err);
    return res
      .status(500)
      .json({ ok: false, error: err.message || "Server error" });
  }
});

export default r;
