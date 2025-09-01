import { PrismaClient } from "@prisma/client";
import moment from "moment-timezone";
import { Router } from "express";

import { renderTemplate as renderHbsFile } from "../helpers/renderTemplates.js";
import { handleAttemptNotifications } from "../lib/notifications.js";
import { sendEmail, sendSMS } from "../helpers/notify.js";
import { QUEBEC_TZ } from "../lib/quebecTime.js";

const prisma = new PrismaClient();
const r = Router();
const { BOOKING_URL, SUPPORT_NUMBER, APP_NAME = "EmploiRapide" } = process.env;

// Utility to validate phone and email
function validateInput(phone, email) {
  const phoneRegex = /^\+1[0-9]{10}$/; // E.164 format for US/Canada
  const emailRegex = /\S+@\S+\.\S+/;
  if (phone && !phoneRegex.test(phone)) throw new Error("Invalid phone number");
  if (email && !emailRegex.test(email)) throw new Error("Invalid email");
}

// API endpoint to test notifications manually
r.post("/notifications", async (req, res) => {
  try {
    const { leadId, phone, email, status, attemptNumber = 1 } = req.body;

    if (!leadId || !status) {
      return res.status(400).json({ error: "leadId and status are required" });
    }

    // Validate input
    validateInput(phone, email);

    // Find or create lead
    let lead = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) {
      lead = await prisma.lead.create({
        data: {
          id: leadId,
          fbLeadId: null,
          fullName: `Manual Test ${leadId}`,
          phone: phone || null,
          email: email || null,
          timezone: QUEBEC_TZ,
          status: "SCHEDULED",
          attempts: 0,
          maxAttempts: 3,
          nextScheduledAt: new Date(),
          callAttempts: {
            create: {
              attemptNumber: 1,
              status: "SCHEDULED",
              scheduledAt: new Date(),
            },
          },
        },
      });
      console.log(`Created test lead ${leadId}`);
    }

    // Update lead status and attempt number
    await prisma.lead.update({
      where: { id: leadId },
      data: { status, attempts: attemptNumber, lastOutcome: status },
    });
    await prisma.callAttempt.update({
      where: { id: lead.callAttempts[0]?.id || lead.callAttempts.create.id },
      data: { status, attemptNumber },
    });

    // Trigger notifications
    await handleAttemptNotifications({ lead, attemptNumber, outcome: status });
    console.log(
      `Triggered notifications for lead ${leadId} with status ${status}`
    );

    // Respond with updated lead data
    const updatedLead = await prisma.lead.findUnique({
      where: { id: leadId },
      include: { callAttempts: true, notificationEvents: true },
    });
    res.json({ ok: true, lead: updatedLead });
  } catch (error) {
    console.error(`Test API error for lead ${req.body.leadId}:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

export default r;
