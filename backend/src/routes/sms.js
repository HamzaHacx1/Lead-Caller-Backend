import { PrismaClient } from "@prisma/client";
// routes/sms.js  (ESM version)
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

// Helpers that match your schema
async function getOrCreateConversationForLead(leadId, twilioNumber) {
  const exists = await prisma.conversation.findFirst({
    where: { leadId, twilioNumber, isOpen: true },
  });
  if (exists) return exists;
  return prisma.conversation.create({
    data: { leadId, twilioNumber, isOpen: true, lastMsgAt: new Date() },
  });
}

async function getOrCreateConversationByPhones(leadPhone, twilioNumber) {
  let lead = await prisma.lead.findFirst({ where: { phone: leadPhone } });
  if (!lead) {
    // Minimal placeholder. If you prefer to throw instead, tell me and we'll switch it.
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
  if (exists) return exists;
  return prisma.conversation.create({
    data: {
      leadId: lead.id,
      twilioNumber,
      isOpen: true,
      lastMsgAt: new Date(),
    },
  });
}

// 1) Outbound send
router.post("/send", async (req, res) => {
  try {
    const { leadId, to, body } = req.body || {};
    if (!to || !body)
      return res.status(400).json({ error: "to and body required" });
    if (!TWILIO_FROM_NUMBER && !TWILIO_MESSAGING_SERVICE_SID) {
      return res.status(500).json({
        error: "Set TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID",
      });
    }

    const twilioNumber = TWILIO_FROM_NUMBER || "messaging_service";
    const conversation = leadId
      ? await getOrCreateConversationForLead(Number(leadId), twilioNumber)
      : await getOrCreateConversationByPhones(to, twilioNumber);

    const msg = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "OUTBOUND",
        fromNumber: TWILIO_FROM_NUMBER || twilioNumber,
        toNumber: to,
        body,
      },
    });

    const payload = {
      to,
      body,
      statusCallback: `${PUBLIC_API_BASE}/sms/status`,
    };
    if (TWILIO_MESSAGING_SERVICE_SID)
      payload.messagingServiceSid = TWILIO_MESSAGING_SERVICE_SID;
    else payload.from = TWILIO_FROM_NUMBER;

    const tw = await twilioClient.messages.create(payload);

    await prisma.message.update({
      where: { id: msg.id },
      data: { providerSid: tw.sid },
    });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMsgAt: new Date() },
    });

    emit("sms:sent", { ...msg, providerSid: tw.sid });
    res.json({ ok: true, id: msg.id, providerSid: tw.sid });
  } catch (e) {
    console.error("sms/send error", e);
    res
      .status(500)
      .json({ error: "send_failed", detail: e?.message || String(e) });
  }
});

// 2) Inbound webhook (Twilio -> us)
router.post("/inbound", async (req, res) => {
  try {
    const { From, To, Body, MessageSid } = req.body || {};
    if (!From || !To) return res.status(200).send("<Response></Response>");

    const convo = await getOrCreateConversationByPhones(From, To);
    const msg = await prisma.message.create({
      data: {
        conversationId: convo.id,
        direction: "INBOUND",
        fromNumber: From,
        toNumber: To,
        body: Body || "",
        providerSid: MessageSid || null,
      },
    });
    await prisma.conversation.update({
      where: { id: convo.id },
      data: { lastMsgAt: new Date() },
    });

    emit("sms:received", msg);
    res.status(200).send("<Response></Response>");
  } catch (e) {
    console.error("sms/inbound error", e);
    res.status(200).send("<Response></Response>"); // Twilio expects 200
  }
});

// 3) Status callback (Twilio -> us)
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
// GET /sms/conversations?open=true&leadId=123&limit=30&cursor=2025-08-17T20:00:00.000Z
router.get("/conversations", async (req, res) => {
  const { open, leadId, cursor, limit = 30, q, twilioNumber } = req.query;

  const where = {
    ...(open !== undefined ? { isOpen: open === "true" } : {}),
    ...(leadId ? { leadId: Number(leadId) } : {}),
    ...(twilioNumber ? { twilioNumber } : {}),
    ...(q
      ? {
          lead: {
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

// GET /sms/messages?conversationId=1&limit=50&cursor=messageId
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
    orderBy: { id: "desc" }, // newest first for chat UIs
    take: Number(limit) + 1,
  });

  const hasMore = msgs.length > Number(limit);
  if (hasMore) msgs.pop();

  res.json({
    messages: msgs,
    nextCursor: hasMore ? msgs[msgs.length - 1]?.id : null,
  });
});
// POST /sms/conversations/:id/send  { body: "Hello" }
router.post("/conversations/:id/send", async (req, res) => {
  const conversationId = Number(req.params.id);
  const { body } = req.body || {};
  if (!body) return res.status(400).json({ error: "body required" });

  const convo = await prisma.conversation.findUnique({
    where: { id: conversationId },
  });
  if (!convo) return res.status(404).json({ error: "conversation_not_found" });

  // fetch lead to get the destination number
  const { lead } = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { Lead: true },
  });

  req.body = { to: lead.phone, body, leadId: lead.id }; // reuse your /send logic
  return router.handle({ ...req, url: "/send", method: "POST" }, res);
});
// POST /sms/messages/mark-read { conversationId, upToId }
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
// PATCH /sms/conversations/:id { isOpen: false }
router.patch("/conversations/:id", async (req, res) => {
  const { isOpen } = req.body || {};
  const updated = await prisma.conversation.update({
    where: { id: Number(req.params.id) },
    data: { isOpen, closedAt: isOpen === false ? new Date() : null },
  });
  res.json(updated);
});
// GET /sms/search?q=term&limit=20
router.get("/search", async (req, res) => {
  const { q, limit = 20 } = req.query;
  if (!q) return res.json({ conversations: [], messages: [] });

  const conversations = await prisma.conversation.findMany({
    where: {
      lead: {
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

export default router;
