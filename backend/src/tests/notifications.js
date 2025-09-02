import { PrismaClient } from "@prisma/client";
import sanitizeHtml from "sanitize-html";
import moment from "moment-timezone";
import { Router } from "express";

import {
  handleAttemptNotifications,
  handleQuickAttemptNotifications,
} from "../lib/notifications.js";
import { renderTemplate } from "../helpers/renderTemplates.js";
import { sendEmail, sendSMS } from "../helpers/notify.js";
import { callOutbound } from "../lib/elevenlabs.js";
import { QUEBEC_TZ } from "../lib/quebecTime.js";
import { pickTz } from "../lib/schedule.js";

const prisma = new PrismaClient();
const r = Router();
const { APP_NAME = "EmploiRapide" } = process.env;
const retryable = ["FAILED", "NO_ANSWER", "VOICEMAIL"];

r.post("/test-flow", async (req, res) => {
  try {
    const {
      full_name,
      phone,
      email,
      timezone,
      outcomes = ["ANSWERED"],
      simulate = true,
      useQuickNotifications = true,
    } = req.body || {};

    if (!full_name || !phone) {
      return res
        .status(400)
        .json({ ok: false, error: "missing_name_or_phone" });
    }

    const sanitizedName = sanitizeHtml(full_name, {
      allowedTags: [],
      allowedAttributes: {},
    });
    const sanitizedPhone = sanitizeHtml(phone, {
      allowedTags: [],
      allowedAttributes: {},
    }).replace(/[^\d+]/g, "");
    const sanitizedEmail = email
      ? sanitizeHtml(email, { allowedTags: [], allowedAttributes: {} })
      : null;

    if (
      sanitizedPhone.length < 10 ||
      (sanitizedEmail && !/\S+@\S+\.\S+/.test(sanitizedEmail))
    ) {
      return res
        .status(400)
        .json({ ok: false, error: "invalid_phone_or_email" });
    }

    const tzForLead = pickTz(timezone) || process.env.DEFAULT_TZ || QUEBEC_TZ;
    const nowUnix = moment().unix();
    const scheduledUnix = nowUnix + 120; // 2 min from now
    const scheduledAt = new Date(scheduledUnix * 1000);

    const lead = await prisma.lead.create({
      data: {
        fbLeadId: `test-${Math.floor(Math.random() * 1000000)}`,
        fullName: sanitizedName,
        phone: sanitizedPhone,
        email: sanitizedEmail,
        timezone: tzForLead,
        status: "SCHEDULED",
        metadata: { testMode: true },
        callAttempts: {
          create: { attemptNumber: 1, status: "SCHEDULED", scheduledAt },
        },
      },
    });

    res.json({ ok: true, leadId: lead.id });

    const handler = useQuickNotifications
      ? handleQuickAttemptNotifications
      : handleAttemptNotifications;

    // ---------------- SIMULATION BRANCH ----------------
    if (simulate) {
      async function simulateFlow() {
        let attemptNumber = 1;
        const outcomesArray = Array.isArray(outcomes) ? outcomes : [outcomes];

        for (const outcome of outcomesArray) {
          const delayMs = attemptNumber === 1 ? 120 * 1000 : 15 * 60 * 1000;
          await new Promise((resolve) => setTimeout(resolve, delayMs));

          if (attemptNumber === 1) {
            try {
              if (sanitizedEmail) {
                const html = renderTemplate("notify.html", {
                  dashboard_link: "https://emploirapide.ca/documents",
                });
                await sendEmail({
                  to: sanitizedEmail,
                  subject: "Tu veux un job ? Il te reste une seule étape !",
                  html,
                  text: `Salut 👋\n\nTu viens de remplir notre formulaire 🙌\nBonne nouvelle : finalise ton inscription ici : ${process.env.DASHBOARD_URL}/complete-profile\n\nÀ bientôt !`,
                });
              }
              await sendSMS({
                to: sanitizedPhone,
                body: `T’as commencé ton inscription, mais ton profil est incomplet. On t’a renvoyé le courriel. Pense à vérifier les spams si jamais.`,
              });
            } catch (err) {
              console.error(
                "[TEST-FLOW] Initial notifications failed:",
                err.message
              );
            }
          }

          // Upsert attempt with simulated outcome
          await prisma.callAttempt.upsert({
            where: {
              leadId_attemptNumber: {
                leadId: lead.id,
                attemptNumber,
              },
            },
            create: {
              leadId: lead.id,
              attemptNumber,
              status: outcome,
              scheduledAt: new Date(),
              startedAt: new Date(),
              endedAt: new Date(),
              transcript: "Simulated transcript for test",
              recordingUrl: "simulated-url",
            },
            update: {
              status: outcome,
              startedAt: new Date(),
              endedAt: new Date(),
              transcript: "Simulated transcript for test",
              recordingUrl: "simulated-url",
            },
          });

          // Update lead with latest attempt count
          const latest = await prisma.callAttempt.findFirst({
            where: { leadId: lead.id },
            orderBy: { attemptNumber: "desc" },
          });
          const attemptsCount = latest?.attemptNumber ?? attemptNumber;

          await prisma.lead.update({
            where: { id: lead.id },
            data: {
              status: outcome,
              lastOutcome: outcome,
              lastAttemptAt: new Date(),
              attempts: attemptsCount,
            },
          });

          // Trigger notifications
          await handler({ lead, attemptNumber, outcome });

          // Retry scheduling
          if (retryable.includes(outcome) && attemptNumber < 3) {
            const nextScheduledUnix = moment()
              .tz(tzForLead)
              .add(15, "minutes")
              .unix();
            await prisma.callAttempt.upsert({
              where: {
                leadId_attemptNumber: {
                  leadId: lead.id,
                  attemptNumber: attemptNumber + 1,
                },
              },
              create: {
                leadId: lead.id,
                attemptNumber: attemptNumber + 1,
                status: "SCHEDULED",
                scheduledAt: new Date(nextScheduledUnix * 1000),
              },
              update: {
                scheduledAt: new Date(nextScheduledUnix * 1000),
              },
            });
          }

          attemptNumber++;
        }
      }

      simulateFlow().catch((e) =>
        console.error("[TEST-FLOW] Simulation error:", e)
      );
    }

    // ---------------- ACTUAL FLOW BRANCH ----------------
    else {
      async function actualFlow() {
        let attemptNumber = 1;

        while (attemptNumber <= 3) {
          const delayMs = attemptNumber === 1 ? 120 * 1000 : 15 * 60 * 1000;
          await new Promise((resolve) => setTimeout(resolve, delayMs));

          if (attemptNumber === 1) {
            try {
              if (sanitizedEmail) {
                const html = renderTemplate("notify.html", {
                  dashboard_link: "https://emploirapide.ca/documents",
                });
                await sendEmail({
                  to: sanitizedEmail,
                  subject: "Tu veux un job ? Il te reste une seule étape !",
                  html,
                  text: `Salut 👋\n\nTu viens de remplir notre formulaire 🙌\nBonne nouvelle : finalise ton inscription ici : ${process.env.DASHBOARD_URL}/complete-profile\n\nÀ bientôt !`,
                });
              }
              await sendSMS({
                to: sanitizedPhone,
                body: `T’as commencé ton inscription, mais ton profil est incomplet. On t’a renvoyé le courriel. Pense à vérifier les spams si jamais.`,
              });
            } catch (err) {
              console.error(
                "[TEST-FLOW] Initial notifications failed:",
                err.message
              );
            }
          }

          // Get current lead and attempt
          const currentLead = await prisma.lead.findUnique({
            where: { id: lead.id },
            include: { callAttempts: true },
          });
          const attempt = currentLead.callAttempts.find(
            (a) => a.attemptNumber === attemptNumber && a.status === "SCHEDULED"
          );
          if (!attempt) break;

          // Trigger actual call
          await callOutbound({
            to: sanitizedPhone,
            lead: currentLead,
            attemptNumber,
            variables: {},
          });

          // Wait 5 minutes for webhook update
          await new Promise((resolve) => setTimeout(resolve, 5 * 60 * 1000));

          // Fetch updated lead + attempt
          const updatedLead = await prisma.lead.findUnique({
            where: { id: lead.id },
            include: { callAttempts: true },
          });
          const updatedAttempt = updatedLead.callAttempts.find(
            (a) => a.attemptNumber === attemptNumber
          );
          const outcome = updatedAttempt?.status || "FAILED";

          // Update lead with latest attempt count
          const latest = await prisma.callAttempt.findFirst({
            where: { leadId: lead.id },
            orderBy: { attemptNumber: "desc" },
          });
          const attemptsCount = latest?.attemptNumber ?? attemptNumber;

          await prisma.lead.update({
            where: { id: lead.id },
            data: {
              status: outcome,
              lastOutcome: outcome,
              lastAttemptAt: new Date(),
              attempts: attemptsCount,
            },
          });

          // Trigger notifications
          await handler({ lead: updatedLead, attemptNumber, outcome });

          if (!retryable.includes(outcome) || attemptNumber >= 3) break;

          // Retry scheduling
          const nextScheduledUnix = moment()
            .tz(tzForLead)
            .add(15, "minutes")
            .unix();
          await prisma.callAttempt.upsert({
            where: {
              leadId_attemptNumber: {
                leadId: lead.id,
                attemptNumber: attemptNumber + 1,
              },
            },
            create: {
              leadId: lead.id,
              attemptNumber: attemptNumber + 1,
              status: "SCHEDULED",
              scheduledAt: new Date(nextScheduledUnix * 1000),
            },
            update: {
              scheduledAt: new Date(nextScheduledUnix * 1000),
            },
          });

          attemptNumber++;
        }
      }

      actualFlow().catch((e) =>
        console.error("[TEST-FLOW] Actual flow error:", e)
      );
    }
  } catch (e) {
    console.error("[TEST-FLOW] Error:", e);
    return res.status(500).json({ ok: false, error: "test_flow_failed" });
  }
});

export default r;
