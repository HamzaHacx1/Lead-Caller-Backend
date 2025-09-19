import { Router } from "express";

import prisma from "../lib/prisma.js";
import { assertJwt } from "../lib/auth.js";
import {
  NOTIFICATION_TEMPLATE_STEPS,
  getDefaultNotificationCopy,
  getNotificationCopy,
  invalidateNotificationTemplateCache,
  primeNotificationTemplateCache,
  sanitizeTemplatePayload,
} from "../lib/notifications.js";

const r = Router();

r.use(assertJwt);

function buildTemplateResponse(stepMeta, overrideRecord, currentCopy, defaultCopy) {
  return {
    step: stepMeta.step,
    isAnswered: stepMeta.isAnswered,
    current: currentCopy,
    defaults: defaultCopy,
    hasOverride: Boolean(overrideRecord),
    updatedAt: overrideRecord?.updatedAt ?? null,
  };
}

r.get("/templates", async (_req, res) => {
  try {
    const overrides = await prisma.notificationTemplate.findMany();
    const overrideMap = new Map(overrides.map((tpl) => [tpl.step, tpl]));

    for (const tpl of overrides) {
      primeNotificationTemplateCache(tpl.step, tpl.data);
    }

    const templates = [];
    for (const stepMeta of NOTIFICATION_TEMPLATE_STEPS) {
      const defaultCopy = getDefaultNotificationCopy(stepMeta.step, {
        isAnswered: stepMeta.isAnswered,
      });
      const currentCopy = await getNotificationCopy(stepMeta.step, {
        isAnswered: stepMeta.isAnswered,
      });
      const overrideRecord = overrideMap.get(stepMeta.step) || null;
      templates.push(
        buildTemplateResponse(stepMeta, overrideRecord, currentCopy, defaultCopy)
      );
      overrideMap.delete(stepMeta.step);
    }

    // Include any overrides stored for steps that are no longer in the defaults list
    for (const leftover of overrideMap.values()) {
      const defaultCopy = getDefaultNotificationCopy(leftover.step, {
        isAnswered: false,
      });
      const currentCopy = await getNotificationCopy(leftover.step, {
        isAnswered: false,
      });
      templates.push(
        buildTemplateResponse(
          { step: leftover.step, isAnswered: false },
          leftover,
          currentCopy,
          defaultCopy
        )
      );
    }

    res.json({ ok: true, templates });
  } catch (error) {
    console.error("[NOTIFICATIONS] list templates failed", error);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

r.put("/templates/:step", async (req, res) => {
  const step = req.params?.step;
  const stepMeta =
    NOTIFICATION_TEMPLATE_STEPS.find((entry) => entry.step === step) || null;

  if (!stepMeta) {
    return res.status(404).json({ ok: false, error: "unknown_step" });
  }

  const sanitized = sanitizeTemplatePayload(req.body || {});
  if (!Object.keys(sanitized).length) {
    return res.status(400).json({ ok: false, error: "empty_payload" });
  }

  try {
    const saved = await prisma.notificationTemplate.upsert({
      where: { step },
      update: { data: sanitized },
      create: { step, data: sanitized },
    });
    primeNotificationTemplateCache(step, sanitized);

    const defaultCopy = getDefaultNotificationCopy(step, {
      isAnswered: stepMeta.isAnswered,
    });
    const currentCopy = await getNotificationCopy(step, {
      isAnswered: stepMeta.isAnswered,
    });

    res.json({
      ok: true,
      template: buildTemplateResponse(stepMeta, saved, currentCopy, defaultCopy),
    });
  } catch (error) {
      console.error(`"[NOTIFICATIONS] update template failed for step ${step}"`, error);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

r.delete("/templates/:step", async (req, res) => {
  const step = req.params?.step;
  const stepMeta =
    NOTIFICATION_TEMPLATE_STEPS.find((entry) => entry.step === step) || null;

  if (!stepMeta) {
    return res.status(404).json({ ok: false, error: "unknown_step" });
  }

  try {
    await prisma.notificationTemplate.delete({ where: { step } });
    invalidateNotificationTemplateCache(step);
  } catch (error) {
    if (error?.code !== "P2025") {
      console.error(
        `"[NOTIFICATIONS] delete template failed for step ${step}"`,
        error
      );
      return res.status(500).json({ ok: false, error: "internal_error" });
    }
    invalidateNotificationTemplateCache(step);
  }

  const defaultCopy = getDefaultNotificationCopy(step, {
    isAnswered: stepMeta.isAnswered,
  });

  res.json({
    ok: true,
    template: buildTemplateResponse(stepMeta, null, defaultCopy, defaultCopy),
  });
});

export default r;
