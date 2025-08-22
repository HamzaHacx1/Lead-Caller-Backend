// helpers/notify.js
import nodemailer from "nodemailer";
import twilio from "twilio";

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_MESSAGING_SERVICE_SID,
  TWILLIO_FROM_NUMBER,
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

/**
 * Send an SMS using Twilio
 * @param {Object} opts
 * @param {string} opts.to - E.164 number e.g. +15551234567
 * @param {string} opts.body - SMS text
 * @param {string} [opts.statusCallback] - webhook URL for delivery updates (optional)
 */
async function sendSMS({ to, body, statusCallback } = {}) {
  if (!to || !body) throw new Error('sendSMS: "to" and "body" are required');
  const client = makeTwilioClient();

  const messagePayload = {
    to,
    body,
  };

  // Prefer Messaging Service SID if provided, else use FROM number
  if (TWILIO_MESSAGING_SERVICE_SID) {
    messagePayload.messagingServiceSid = TWILIO_MESSAGING_SERVICE_SID;
  } else if (TWILLIO_FROM_NUMBER) {
    messagePayload.from = TWILLIO_FROM_NUMBER;
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

/**
 * Send an email using Nodemailer
 * @param {Object} opts
 * @param {string|string[]} opts.to - recipient(s)
 * @param {string} opts.subject
 * @param {string} [opts.text] - plain text body
 * @param {string} [opts.html] - HTML body
 * @param {Array} [opts.attachments] - nodemailer attachment objects
 * @param {string|string[]} [opts.cc]
 * @param {string|string[]} [opts.bcc]
 * @param {string} [opts.replyTo]
 * @param {string} [opts.fromOverride] - override default from
 */
async function sendEmail({
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

  // For most SMTPs, info.messageId is available; for some providers you may also get preview URLs in dev
  return {
    messageId: info.messageId,
    accepted: info.accepted,
    rejected: info.rejected,
    envelope: info.envelope,
    response: info.response,
  };
}

/** ---------- Optional tiny templating ---------- */
function renderTemplate(template, vars = {}) {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    return String(vars[key] ?? "");
  });
}

module.exports = {
  sendSMS,
  sendEmail,
  renderTemplate,
};
