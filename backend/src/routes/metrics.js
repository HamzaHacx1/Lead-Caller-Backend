import { Router } from "express";

import { assertJwt } from "../lib/auth.js";
import prisma from "../lib/prisma.js";

const r = Router();

/** ---------------- constants ---------------- */
const LEAD_STATUS_SET = new Set([
  "NEW",
  "SCHEDULED",
  "IN_PROGRESS",
  "ANSWERED",
  "VOICEMAIL",
  "NO_ANSWER",
  "FAILED",
  "ERROR",
  "ARCHIVED",
]);

const ATTEMPT_STATUS_FINAL = [
  "ANSWERED",
  "VOICEMAIL",
  "NO_ANSWER",
  "FAILED",
  "CANCELED",
];

const ATTEMPT_STATUS_COUNTABLE = [
  "ANSWERED",
  "VOICEMAIL",
  "NO_ANSWER",
  "FAILED",
];

const STATUS_KEY_MAP = {
  ANSWERED: "answered",
  VOICEMAIL: "voicemail",
  NO_ANSWER: "noAnswer",
  FAILED: "failed",
  CANCELED: "canceled",
};

/** ---------------- utils ---------------- */
function parseISODate(d) {
  if (!d) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return null;
  const dt = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`);
  return Number.isNaN(dt.getTime()) ? null : dt;
}
function addDays(date, n) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}
function dateKeyUTC(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}
function clampRange(fromStr, toStr) {
  // defaults: last 7 days including today
  const today = new Date();
  const todayUTC = toUTCDate(today);
  const defFrom = addDays(todayUTC, -6);

  const from = parseISODate(fromStr) || defFrom;
  const to = parseISODate(toStr) || todayUTC;

  // inclusive end → convert to [gte, lt nextDay]
  const lt = addDays(to, 1);
  return { from, lt };
}
function sanitizeOutcome(raw) {
  if (raw === null || raw === undefined) return "";
  return String(raw).trim().toUpperCase();
}
function toUTCDate(date) {
  if (!(date instanceof Date)) return null;
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}
function leadWhere({ from, lt, outcome }) {
  const where = {
    createdAt: { gte: from, lt },
  };
  if (outcome && LEAD_STATUS_SET.has(outcome)) {
    where.status = outcome;
  }
  return where;
}
function attemptWhere({ from, lt, outcome }) {
  const baseFilter = {
    OR: [
      { endedAt: { gte: from, lt } },
      { endedAt: null, updatedAt: { gte: from, lt } },
    ],
  };

  if (outcome) {
    if (!ATTEMPT_STATUS_FINAL.includes(outcome)) {
      return null;
    }
    return {
      status: outcome,
      ...baseFilter,
    };
  }

  return {
    status: { in: ATTEMPT_STATUS_FINAL },
    ...baseFilter,
  };
}
function attemptEffectiveDate(attempt) {
  if (!attempt) return null;
  return (
    attempt.endedAt ||
    attempt.updatedAt ||
    attempt.scheduledAt ||
    attempt.createdAt ||
    null
  );
}
function mapStatusToSeriesKey(status) {
  return STATUS_KEY_MAP[status] || null;
}

/** ---------------- endpoints ---------------- */

// SUMMARY
// GET /metrics/summary?from=YYYY-MM-DD&to=YYYY-MM-DD&agent=A1&outcome=ANSWERED
r.get("/summary", assertJwt, async (req, res) => {
  try {
    const { from, lt } = clampRange(req.query.from, req.query.to);
    const agent = req.query.agent || "";
    const outcome = sanitizeOutcome(req.query.outcome);
    const notes = [];

    if (agent) {
      notes.push(
        "Agent filtering is not yet supported because call attempts do not store agent references."
      );
    }

    const today = new Date();
    const todayUTC = toUTCDate(today);
    const tomorrowUTC = addDays(todayUTC, 1);

    const todayWhere = leadWhere({ from: todayUTC, lt: tomorrowUTC, outcome });
    const leadRangeWhere = leadWhere({ from, lt, outcome });
    const attemptRangeWhere = attemptWhere({ from, lt, outcome });

    const todayLeadsPromise = prisma.lead.count({ where: todayWhere });
    const leadsInRangePromise = prisma.lead.count({ where: leadRangeWhere });
    const leadsWithoutAttemptPromise = prisma.lead.count({
      where: {
        createdAt: { gte: from, lt },
        callAttempts: {
          none: {
            status: { in: ATTEMPT_STATUS_COUNTABLE },
          },
        },
      },
    });
    const openLeadsPromise = prisma.lead.count({
      where: { status: { in: ["NEW", "SCHEDULED", "IN_PROGRESS"] } },
    });
    const overdueScheduledPromise = prisma.lead.count({
      where: {
        status: "SCHEDULED",
        nextScheduledAt: { lt: new Date() },
      },
    });
    const neverAttemptedTotalPromise = prisma.lead.count({
      where: {
        callAttempts: {
          none: {
            status: { in: ATTEMPT_STATUS_COUNTABLE },
          },
        },
      },
    });

    const attemptsPromise = attemptRangeWhere
      ? prisma.callAttempt.findMany({
          where: attemptRangeWhere,
          select: {
            leadId: true,
            status: true,
            endedAt: true,
            updatedAt: true,
            scheduledAt: true,
            createdAt: true,
          },
        })
      : Promise.resolve([]);

    const [
      todayLeads,
      leadsInRange,
      leadsWithoutAttempt,
      openLeads,
      overdueScheduled,
      totalLeadsNeverAttempted,
      attempts,
    ] = await Promise.all([
      todayLeadsPromise,
      leadsInRangePromise,
      leadsWithoutAttemptPromise,
      openLeadsPromise,
      overdueScheduledPromise,
      neverAttemptedTotalPromise,
      attemptsPromise,
    ]);

    const attemptCounts = Object.create(null);
    ATTEMPT_STATUS_FINAL.forEach((status) => {
      attemptCounts[status] = 0;
    });
    const leadsTouched = new Set();

    for (const attempt of attempts) {
      if (attempt?.leadId) leadsTouched.add(attempt.leadId);
      if (!(attempt.status in attemptCounts)) {
        attemptCounts[attempt.status] = 0;
      }
      attemptCounts[attempt.status] += 1;
    }

    const totalAttempts = ATTEMPT_STATUS_FINAL.reduce(
      (sum, status) => sum + (attemptCounts[status] || 0),
      0
    );
    const callsCompleted = ATTEMPT_STATUS_COUNTABLE.reduce(
      (sum, status) => sum + (attemptCounts[status] || 0),
      0
    );
    const answeredRate =
      callsCompleted > 0 ? attemptCounts.ANSWERED / callsCompleted : 0;

    res.json({
      todayLeads,
      leadsInRange,
      leadsWithoutAttempt,
      totalLeadsNeverAttempted,
      leadsTouched: leadsTouched.size,
      openLeads,
      overdueScheduled,
      callsCompleted,
      totalAttempts,
      answered: attemptCounts.ANSWERED || 0,
      voicemail: attemptCounts.VOICEMAIL || 0,
      noAnswer: attemptCounts.NO_ANSWER || 0,
      failed: attemptCounts.FAILED || 0,
      canceled: attemptCounts.CANCELED || 0,
      answeredRate,
      notes,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "summary_failed" });
  }
});

// TIMESERIES (daily buckets for charts)
// GET /metrics/timeseries?from=YYYY-MM-DD&to=YYYY-MM-DD&agent=&outcome=
r.get("/timeseries", assertJwt, async (req, res) => {
  try {
    const { from, lt } = clampRange(req.query.from, req.query.to);
    const outcome = sanitizeOutcome(req.query.outcome);

    const leadRangeWhere = leadWhere({ from, lt, outcome });
    const attemptRangeWhere = attemptWhere({ from, lt, outcome });

    const leadsPromise = prisma.lead.findMany({
      where: leadRangeWhere,
      select: { createdAt: true },
      orderBy: { createdAt: "asc" },
    });

    const attemptsPromise = attemptRangeWhere
      ? prisma.callAttempt.findMany({
          where: attemptRangeWhere,
          select: {
            status: true,
            endedAt: true,
            updatedAt: true,
            scheduledAt: true,
            createdAt: true,
          },
        })
      : Promise.resolve([]);

    const [leads, attempts] = await Promise.all([
      leadsPromise,
      attemptsPromise,
    ]);

    const buckets = {};
    for (let d = new Date(from); d < lt; d = addDays(d, 1)) {
      const key = dateKeyUTC(d);
      buckets[key] = {
        date: key,
        leads: 0,
        answered: 0,
        voicemail: 0,
        noAnswer: 0,
        failed: 0,
        canceled: 0,
      };
    }

    for (const lead of leads) {
      const day = toUTCDate(lead.createdAt);
      if (!day) continue;
      const key = dateKeyUTC(day);
      if (buckets[key]) {
        buckets[key].leads += 1;
      }
    }

    for (const attempt of attempts) {
      const when = attemptEffectiveDate(attempt);
      if (!when) continue;
      const day = toUTCDate(when);
      if (!day) continue;
      const key = dateKeyUTC(day);
      const bucket = buckets[key];
      if (!bucket) continue;
      const seriesKey = mapStatusToSeriesKey(attempt.status);
      if (!seriesKey) continue;
      bucket[seriesKey] = (bucket[seriesKey] || 0) + 1;
    }

    res.json(Object.values(buckets));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "timeseries_failed" });
  }
});

// OUTCOMES (total counts by status in range)
// GET /metrics/outcomes?from=YYYY-MM-DD&to=YYYY-MM-DD&agent=&outcome=
r.get("/outcomes", assertJwt, async (req, res) => {
  try {
    const { from, lt } = clampRange(req.query.from, req.query.to);
    const outcome = sanitizeOutcome(req.query.outcome);

    const attemptRangeWhere = attemptWhere({ from, lt, outcome });
    if (!attemptRangeWhere) {
      return res.json([]);
    }

    const groups = await prisma.callAttempt.groupBy({
      by: ["status"],
      where: attemptRangeWhere,
      _count: { _all: true },
    });

    const counts = groups.reduce((acc, row) => {
      acc[row.status] = row._count?._all ?? 0;
      return acc;
    }, Object.create(null));

    const result = ATTEMPT_STATUS_FINAL.map((status) => ({
      outcome: status,
      count: counts[status] || 0,
    }));

    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "outcomes_failed" });
  }
});

// AGENTS (for filter dropdown)
// GET /metrics/agents
r.get("/agents", assertJwt, async (_req, res) => {
  try {
    const agents = await prisma.agent.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    res.json(agents);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "agents_failed" });
  }
});

// (Optional) original endpoints retained for convenience
r.get("/leads", assertJwt, async (_req, res) => {
  const leads = await prisma.lead.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  res.json(leads);
});
r.get("/attempts", assertJwt, async (_req, res) => {
  const attempts = await prisma.callAttempt.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  res.json(attempts);
});

export default r;
