import { PrismaClient } from "@prisma/client";
// routes/sms.js (ESM)
import express from "express";
import Twilio from "twilio";

import { emit } from "../lib/realtime.js";

const router = express.Router();
const prisma = new PrismaClient();

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  TWILIO_MESSAGING_SERVICE_SID,
  PUBLIC_API_BASE,
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  throw new Error("Twilio credentials missing in ENV");
}
const twilioClient = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

/* --------------------------- helpers --------------------------- */
async function getOrCreateConversationForLead(leadId, twilioNumber) {
  const exists = await prisma.conversation.findFirst({
    where: { leadId, twilioNumber, isOpen: true },
  });
  if (exists) return { conversation: exists, created: false };
  const created = await prisma.conversation.create({
    data: { leadId, twilioNumber, isOpen: true, lastMsgAt: new Date() },
  });
  return { conversation: created, created: true };
}

async function getOrCreateConversationByPhones(leadPhone, twilioNumber) {
  let lead = await prisma.lead.findFirst({ where: { phone: leadPhone } });
  if (!lead) {
    lead = await prisma.lead.create({
      data: {
        fullName: "Unknown Lead",
        email: null,
        phone: leadPhone,
        timezone: "America/Toronto",
        source: "sms_inbound",
      },
    });
  }
  const exists = await prisma.conversation.findFirst({
    where: { leadId: lead.id, twilioNumber, isOpen: true },
  });
  if (exists) return { conversation: exists, created: false };
  const created = await prisma.conversation.create({
    data: {
      leadId: lead.id,
      twilioNumber,
      isOpen: true,
      lastMsgAt: new Date(),
    },
  });
  return { conversation: created, created: true };
}

/** Core SMS sender used by both /send and /conversations/:id/send */
async function sendSmsCore({ to, body, leadId, mediaUrls = [] }) {
  if (!to || !body) throw new Error("to and body required");
  if (!TWILIO_FROM_NUMBER && !TWILIO_MESSAGING_SERVICE_SID) {
    throw new Error("Set TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID");
  }

  const twilioNumber = TWILIO_FROM_NUMBER || "messaging_service";
  const { conversation, created } = leadId
    ? await getOrCreateConversationForLead(Number(leadId), twilioNumber)
    : await getOrCreateConversationByPhones(to, twilioNumber);

  // Create local message first (optimistic)
  let msg = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: "OUTBOUND",
      fromNumber: TWILIO_FROM_NUMBER || twilioNumber,
      toNumber: to,
      body,
      mediaUrls, // [] is fine
      mediaContentTypes: [], // unknown for outbound unless you track them
    },
  });

  const payload = {
    to,
    body,
    statusCallback: `${PUBLIC_API_BASE}/sms/status`,
    ...(mediaUrls.length ? { mediaUrl: mediaUrls } : {}),
    ...(TWILIO_MESSAGING_SERVICE_SID
      ? { messagingServiceSid: TWILIO_MESSAGING_SERVICE_SID }
      : { from: TWILIO_FROM_NUMBER }),
  };

  const tw = await twilioClient.messages.create(payload);

  // backfill provider SID and touch conversation
  msg = await prisma.message.update({
    where: { id: msg.id },
    data: { providerSid: tw.sid },
  });
  const updatedConvo = await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMsgAt: new Date() },
    include: { Lead: true },
  });

  if (created) emit("sms:newConversation", updatedConvo);
  emit("sms:sent", msg);

  return {
    ok: true,
    id: msg.id,
    providerSid: tw.sid,
    conversationId: conversation.id,
  };
}

/* ----------------------------- routes ----------------------------- */

// Start/continue a conversation (body: { to, body, leadId?, mediaUrls? })
router.post("/send", async (req, res) => {
  try {
    const { to, body, leadId, mediaUrls = [] } = req.body || {};
    const result = await sendSmsCore({ to, body, leadId, mediaUrls });
    res.json(result);
  } catch (e) {
    console.error("sms/send error", e);
    res
      .status(400)
      .json({ error: "send_failed", detail: e?.message || String(e) });
  }
});

// Twilio inbound webhook (MMS aware)
router.post("/inbound", async (req, res) => {
  try {
    const { From, To, Body, MessageSid } = req.body || {};
    if (!From || !To) return res.status(200).send("<Response></Response>");

    const n = Number(req.body.NumMedia || 0);
    const mediaUrls = Array.from({ length: n }, (_, i) => {
      const mediaSid = req.body[`MediaUrl${i}`].split("/").pop();
      return `/api/sms/media/${MessageSid}/${mediaSid}`;
    });
    const mediaContentTypes = Array.from(
      { length: n },
      (_, i) => req.body[`MediaContentType${i}`]
    ).filter(Boolean);

    // ✅ get conversation first
    const { conversation } = await getOrCreateConversationByPhones(From, To);

    const msg = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "INBOUND",
        fromNumber: From,
        toNumber: To,
        body: Body || "",
        providerSid: MessageSid || null,
        mediaUrls,
        mediaContentTypes,
      },
    });

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMsgAt: new Date() },
    });

    emit("sms:received", msg);
    res.status(200).send("<Response></Response>");
  } catch (e) {
    console.error("sms/inbound error", e);
    res.status(200).send("<Response></Response>");
  }
});

// Twilio status callback
router.post("/status", async (req, res) => {
  try {
    const { MessageSid, MessageStatus, ErrorCode, ErrorMessage } =
      req.body || {};
    emit("sms:status", {
      sid: MessageSid,
      status: MessageStatus,
      errorCode: ErrorCode,
      errorMessage: ErrorMessage,
    });
    res.status(200).send("OK");
  } catch (e) {
    console.error("sms/status error", e);
    res.status(200).send("OK");
  }
});

// List conversations (supports q/open/leadId/twilioNumber/cursor/limit)
router.get("/conversations", async (req, res) => {
  const { open, leadId, cursor, limit = 30, q, twilioNumber } = req.query;

  const where = {
    ...(open !== undefined ? { isOpen: open === "true" } : {}),
    ...(leadId ? { leadId: Number(leadId) } : {}),
    ...(twilioNumber ? { twilioNumber } : {}),
    ...(q
      ? {
          // NOTE: relation field is "Lead", not "lead"
          Lead: {
            OR: [
              { fullName: { contains: q, mode: "insensitive" } },
              { phone: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
            ],
          },
        }
      : {}),
    ...(cursor ? { lastMsgAt: { lt: new Date(cursor) } } : {}),
  };

  const rows = await prisma.conversation.findMany({
    where,
    orderBy: { lastMsgAt: "desc" },
    take: Number(limit) + 1,
    include: { Lead: true },
  });

  const hasMore = rows.length > Number(limit);
  if (hasMore) rows.pop();

  res.json({
    conversations: rows,
    nextCursor: hasMore ? rows[rows.length - 1]?.lastMsgAt : null,
  });
});

// Get messages (newest first in DB; UI can reverse)
router.get("/messages", async (req, res) => {
  const { conversationId, limit = 50, cursor } = req.query;
  if (!conversationId)
    return res.status(400).json({ error: "conversationId required" });

  const where = {
    conversationId: Number(conversationId),
    ...(cursor ? { id: { lt: Number(cursor) } } : {}),
  };

  const msgs = await prisma.message.findMany({
    where,
    orderBy: { id: "desc" },
    take: Number(limit) + 1,
  });

  const hasMore = msgs.length > Number(limit);
  if (hasMore) msgs.pop();

  res.json({
    messages: msgs,
    nextCursor: hasMore ? msgs[msgs.length - 1]?.id : null,
  });
});

// Send into an existing conversation
router.post("/conversations/:id/send", async (req, res) => {
  try {
    const conversationId = Number(req.params.id);
    const { body, mediaUrls = [] } = req.body || {};
    if (!body) return res.status(400).json({ error: "body required" });

    const convo = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { Lead: true },
    });
    if (!convo)
      return res.status(404).json({ error: "conversation_not_found" });

    const result = await sendSmsCore({
      to: convo.Lead.phone,
      body,
      leadId: convo.leadId,
      mediaUrls,
    });

    res.json(result);
  } catch (e) {
    console.error("sms/conversations/:id/send error", e);
    res.status(400).json({ error: e?.message || "send_failed" });
  }
});

// Mark inbound messages read
router.post("/messages/mark-read", async (req, res) => {
  const { conversationId, upToId } = req.body || {};
  await prisma.message.updateMany({
    where: {
      conversationId: Number(conversationId),
      id: { lte: Number(upToId) },
      readAt: null,
      direction: "INBOUND",
    },
    data: { readAt: new Date() },
  });
  res.json({ ok: true });
});

// Open/close conversation
router.patch("/conversations/:id", async (req, res) => {
  const { isOpen } = req.body || {};
  const updated = await prisma.conversation.update({
    where: { id: Number(req.params.id) },
    data: { isOpen, closedAt: isOpen === false ? new Date() : null },
  });
  res.json(updated);
});

// Search conversations + messages
router.get("/search", async (req, res) => {
  const { q, limit = 20 } = req.query;
  if (!q) return res.json({ conversations: [], messages: [] });

  const conversations = await prisma.conversation.findMany({
    where: {
      Lead: {
        OR: [
          { fullName: { contains: q, mode: "insensitive" } },
          { phone: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
        ],
      },
    },
    take: Number(limit),
    include: { Lead: true },
    orderBy: { lastMsgAt: "desc" },
  });

  const messages = await prisma.message.findMany({
    where: { body: { contains: q, mode: "insensitive" } },
    take: Number(limit),
    orderBy: { id: "desc" },
  });

  res.json({ conversations, messages });
});
// Secure Twilio Media Proxy
router.get("/media/:messageSid/:mediaSid", async (req, res) => {
  try {
    const { messageSid, mediaSid } = req.params;

    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages/${messageSid}/Media/${mediaSid}`;

    const auth = Buffer.from(
      `${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`
    ).toString("base64");

    const r = await fetch(url, {
      headers: { Authorization: `Basic ${auth}` },
    });

    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).send(text);
    }

    res.set("Content-Type", r.headers.get("content-type"));
    res.set("Cache-Control", "public, max-age=3600");

    r.body.pipe(res);
  } catch (err) {
    console.error("media proxy error", err);
    res.status(500).send("Error fetching media from Twilio");
  }
});

export default router;
