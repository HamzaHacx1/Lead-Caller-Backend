import { Router } from "express";

import { assertJwt } from "../lib/auth.js";
import prisma from "../lib/prisma.js";

const r = Router();

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
  const todayUTC = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  );
  const defFrom = addDays(todayUTC, -6);

  const from = parseISODate(fromStr) || defFrom;
  const to = parseISODate(toStr) || todayUTC;

  // inclusive end → convert to [gte, lt nextDay]
  const lt = addDays(to, 1);
  return { from, lt };
}
function leadWhere({ from, lt, agent, outcome }) {
  const where = {
    createdAt: { gte: from, lt },
  };
  if (outcome) where.status = outcome;
  if (agent) {
    // Filter leads that have at least one call attempt by this agent
    where.callAttempts = { some: { agentId: agent } };
  }
  return where;
}

/** ---------------- endpoints ---------------- */

// SUMMARY
// GET /metrics/summary?from=YYYY-MM-DD&to=YYYY-MM-DD&agent=A1&outcome=ANSWERED
r.get("/summary", assertJwt, async (req, res) => {
  try {
    const { from, lt } = clampRange(req.query.from, req.query.to);
    const agent = req.query.agent || undefined;
    const outcome = req.query.outcome || undefined;

    const whereBase = leadWhere({ from, lt, agent, outcome });

    // Today range (UTC-based)
    const now = new Date();
    const todayUTC = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    );
    const todayWhere = {
      createdAt: { gte: todayUTC, lt: addDays(todayUTC, 1) },
      ...(agent ? { callAttempts: { some: { agentId: agent } } } : {}),
    };

    const [todayLeads, answered, failed, noAnswer, voicemail] =
      await Promise.all([
        prisma.lead.count({ where: todayWhere }),
        prisma.lead.count({ where: { ...whereBase, status: "ANSWERED" } }),
        prisma.lead.count({ where: { ...whereBase, status: "FAILED" } }),
        prisma.lead.count({ where: { ...whereBase, status: "NO_ANSWER" } }),
        prisma.lead.count({ where: { ...whereBase, status: "VOICEMAIL" } }),
      ]);

    res.json({ todayLeads, answered, failed, noAnswer, voicemail });
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
    const agent = req.query.agent || undefined;
    const outcome = req.query.outcome || undefined;

    const where = leadWhere({ from, lt, agent, outcome });

    // Pull only what we need and aggregate in JS (keeps it simple + Prisma-safe)
    const leads = await prisma.lead.findMany({
      where,
      select: { createdAt: true, status: true },
      orderBy: { createdAt: "asc" },
    });

    // Make empty buckets for every date in range
    const buckets = {};
    for (let d = new Date(from); d < lt; d = addDays(d, 1)) {
      buckets[dateKeyUTC(d)] = {
        date: dateKeyUTC(d),
        leads: 0,
        answered: 0,
        failed: 0,
        noAnswer: 0,
        voicemail: 0,
      };
    }

    // Fill buckets
    for (const l of leads) {
      const key = dateKeyUTC(
        new Date(
          Date.UTC(
            l.createdAt.getUTCFullYear(),
            l.createdAt.getUTCMonth(),
            l.createdAt.getUTCDate()
          )
        )
      );
      const b = buckets[key];
      if (!b) continue;
      b.leads += 1;
      switch (l.status) {
        case "ANSWERED":
          b.answered += 1;
          break;
        case "FAILED":
          b.failed += 1;
          break;
        case "NO_ANSWER":
          b.noAnswer += 1;
          break;
        case "VOICEMAIL":
          b.voicemail += 1;
          break;
        default:
          break;
      }
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
    const agent = req.query.agent || undefined;
    const outcome = req.query.outcome || undefined;

    const where = leadWhere({ from, lt, agent, outcome });

    // Pull statuses and count in JS (simple + portable)
    const rows = await prisma.lead.findMany({
      where,
      select: { status: true },
    });

    const counts = rows.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    }, {});

    const result = Object.entries(counts).map(([status, count]) => ({
      outcome: status,
      count,
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
