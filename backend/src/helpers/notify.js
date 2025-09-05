import dotenv from "dotenv";

dotenv.config();

import nodemailer from "nodemailer";
import twilio from "twilio";

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_MESSAGING_SERVICE_SID,
  TWILIO_FROM_NUMBER,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  SMTP_PASS,
  EMAIL_FROM,
} = process.env;

/** ---------- Twilio SMS ---------- */
function makeTwilioClient() {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    throw new Error(
      "Missing Twilio credentials (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)."
    );
  }
  return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

export async function sendSMS({ to, body, statusCallback } = {}) {
  if (!to || !body) throw new Error('sendSMS: "to" and "body" are required');
  const client = makeTwilioClient();

  const messagePayload = { to, body };

  if (TWILIO_MESSAGING_SERVICE_SID) {
    messagePayload.messagingServiceSid = TWILIO_MESSAGING_SERVICE_SID;
  } else if (TWILIO_FROM_NUMBER) {
    messagePayload.from = TWILIO_FROM_NUMBER;
  } else {
    throw new Error(
      "Provide TWILIO_MESSAGING_SERVICE_SID or TWILLIO_FROM_NUMBER in environment."
    );
  }

  if (statusCallback) messagePayload.statusCallback = statusCallback;

  const res = await client.messages.create(messagePayload);
  return {
    sid: res.sid,
    status: res.status,
    to: res.to,
    body: res.body,
    dateCreated: res.dateCreated,
  };
}

/** ---------- Nodemailer Email ---------- */
function makeTransport() {
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    throw new Error(
      "Missing SMTP config (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS)."
    );
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: String(SMTP_SECURE).toLowerCase() === "true",
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

export async function sendEmail({
  to,
  subject,
  text,
  html,
  attachments,
  cc,
  bcc,
  replyTo,
  fromOverride,
} = {}) {
  if (!to || !subject || (!text && !html)) {
    throw new Error(
      'sendEmail: "to", "subject", and one of "text" or "html" are required'
    );
  }

  const transporter = makeTransport();
  const mail = {
    from: fromOverride || EMAIL_FROM || SMTP_USER,
    to,
    subject,
    text,
    html,
    cc,
    bcc,
    replyTo,
    attachments,
  };

  const info = await transporter.sendMail(mail);

  return {
    messageId: info.messageId,
    accepted: info.accepted,
    rejected: info.rejected,
    envelope: info.envelope,
    response: info.response,
  };
}

/** ---------- Optional tiny templating ---------- */
export function renderTemplate(template, vars = {}) {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    return String(vars[key] ?? "");
  });
}
