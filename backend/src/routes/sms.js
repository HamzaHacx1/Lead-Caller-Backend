const express = require("express");
const router = express.Router();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const Twilio = require("twilio");
const { emit } = require("../lib/realtime").default;

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

module.exports = router;
