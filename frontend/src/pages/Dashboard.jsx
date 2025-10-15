import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  CartesianGrid,
  Legend,
  Cell,
} from "recharts";
import React, { useEffect, useMemo, useState } from "react";

import StatCard from "../components/StatCard";
import { api } from "../lib/api";

// Add near top of file
const COLORS = {
  leads: "#3B82F6",
  answered: "#22C55E",
  voicemail: "#F59E0B",
  noAnswer: "#9CA3AF",
  failed: "#EF4444",
  canceled: "#6366F1",
};

/** ---------- tiny utils ---------- */
function fmtISO(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function daysAgo(n) {
  const d = startOfToday();
  d.setDate(d.getDate() - n);
  return d;
}
function withQuery(path, params) {
  const q = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && `${v}`.length) q.set(k, v);
  });
  return `${path}?${q.toString()}`;
}
function formatPercent(value) {
  if (!Number.isFinite(value) || value <= 0) return "0%";
  if (value >= 0.999) return "100%";
  const scaled = value * 100;
  const digits = scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)}%`;
}

/** ---------- Dashboard ---------- */
export default function Dashboard() {
  // filters
  const [range, setRange] = useState("7d"); // 'today' | '7d' | '30d' | 'custom'
  const [from, setFrom] = useState(fmtISO(daysAgo(6))); // inclusive
  const [to, setTo] = useState(fmtISO(startOfToday())); // inclusive
  const [agent, setAgent] = useState("");
  const [outcome, setOutcome] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(false);

  // data
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState(null);
  const [series, setSeries] = useState([]);
  const [outcomes, setOutcomes] = useState([]);
  const [agents, setAgents] = useState([]);
  const [err, setErr] = useState("");

  // derive date range from quick filter
  useEffect(() => {
    if (range === "custom") return;
    if (range === "today") {
      setFrom(fmtISO(startOfToday()));
      setTo(fmtISO(startOfToday()));
    } else if (range === "7d") {
      setFrom(fmtISO(daysAgo(6)));
      setTo(fmtISO(startOfToday()));
    } else if (range === "30d") {
      setFrom(fmtISO(daysAgo(29)));
      setTo(fmtISO(startOfToday()));
    }
  }, [range]);

  // load agents (once)
  useEffect(() => {
    api("/metrics/agents")
      .then((a) => setAgents(a || []))
      .catch(() => setAgents([]));
  }, []);

  // fetch function
  async function fetchAll() {
    setLoading(true);
    setErr("");
    const q = { from, to, agent, outcome };
    try {
      const [s, ts, oc] = await Promise.all([
        api(withQuery("/metrics/summary", q)),
        api(withQuery("/metrics/timeseries", q)),
        api(withQuery("/metrics/outcomes", q)),
      ]);
      setStats(s);
      setSeries(Array.isArray(ts) ? ts : []);
      setOutcomes(Array.isArray(oc) ? oc : []);
    } catch (e) {
      console.error(e);
      setErr("Failed to load metrics");
    } finally {
      setLoading(false);
    }
  }

  // initial + on filter change
  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, agent, outcome]);

  // auto refresh
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(fetchAll, 15_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, from, to, agent, outcome]);

  const totalLeads = useMemo(() => {
    if (typeof stats?.leadsInRange === "number") return stats.leadsInRange;
    if (!series?.length) return 0;
    return series.reduce((acc, d) => acc + (d.leads || 0), 0);
  }, [series, stats]);

  const callsCompleted = stats?.callsCompleted ?? 0;
  const answeredRate = stats?.answeredRate ?? 0;
  const leadsWithoutAttempt = stats?.leadsWithoutAttempt ?? 0;
  const openLeads = stats?.openLeads ?? 0;
  const overdueScheduled = stats?.overdueScheduled ?? 0;
  const totalLeadsNeverAttempted = stats?.totalLeadsNeverAttempted ?? 0;
  const leadsTouched = stats?.leadsTouched ?? 0;
  const totalAttempts = stats?.totalAttempts ?? 0;

  const advisoryNotes = useMemo(() => {
    const items = [...(stats?.notes ?? [])];
    if (leadsWithoutAttempt > 0) {
      items.push(
        `${leadsWithoutAttempt} lead${
          leadsWithoutAttempt === 1 ? "" : "s"
        } in this range still have no completed call attempt. Check intake or scheduling.`
      );
    }
    if (overdueScheduled > 0) {
      items.push(
        `${overdueScheduled} scheduled lead${
          overdueScheduled === 1 ? "" : "s"
        } are past their planned call time. Review the calls worker queue.`
      );
    }
    return items;
  }, [stats, leadsWithoutAttempt, overdueScheduled]);

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setRange("today")}
            className={`px-3 py-1 rounded-full border ${
              range === "today" ? "bg-black text-white" : "hover:bg-slate-100"
            }`}
          >
            Today
          </button>
          <button
            onClick={() => setRange("7d")}
            className={`px-3 py-1 rounded-full border ${
              range === "7d" ? "bg-black text-white" : "hover:bg-slate-100"
            }`}
          >
            Last 7 days
          </button>
          <button
            onClick={() => setRange("30d")}
            className={`px-3 py-1 rounded-full border ${
              range === "30d" ? "bg-black text-white" : "hover:bg-slate-100"
            }`}
          >
            Last 30 days
          </button>
          <button
            onClick={() => setRange("custom")}
            className={`px-3 py-1 rounded-full border ${
              range === "custom" ? "bg-black text-white" : "hover:bg-slate-100"
            }`}
          >
            Custom
          </button>

          <div className="flex items-center gap-2">
            <input
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setRange("custom");
              }}
              className="px-2 py-1 border rounded"
            />
            <span>→</span>
            <input
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setRange("custom");
              }}
              className="px-2 py-1 border rounded"
            />
          </div>

          <select
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            className="px-2 py-1 border rounded"
          >
            <option value="">All agents</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name ?? a.id}
              </option>
            ))}
          </select>

          <select
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
            className="px-2 py-1 border rounded"
          >
            <option value="">All outcomes</option>
            <option value="ANSWERED">Answered</option>
            <option value="VOICEMAIL">Voicemail</option>
            <option value="NO_ANSWER">No Answer</option>
            <option value="FAILED">Failed</option>
            <option value="CANCELED">Canceled</option>
          </select>
        </div>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            Auto refresh
          </label>
          <button
            onClick={fetchAll}
            className="px-3 py-2 border rounded hover:bg-slate-100"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Stats */}
      {loading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : err ? (
        <div className="text-sm text-red-600">{err}</div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
            <StatCard label="Leads (range)" value={totalLeads} />
            <StatCard label="Leads Today" value={stats?.todayLeads ?? 0} />
            <StatCard label="Calls Completed" value={callsCompleted} />
            <StatCard label="Total Attempts" value={totalAttempts} />
            <StatCard label="Answered Calls" value={stats?.answered ?? 0} />
            <StatCard label="Contact Rate" value={formatPercent(answeredRate)} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <StatCard label="Voicemail" value={stats?.voicemail ?? 0} />
            <StatCard label="No Answer" value={stats?.noAnswer ?? 0} />
            <StatCard label="Failed" value={stats?.failed ?? 0} />
            <StatCard label="Canceled" value={stats?.canceled ?? 0} />
            <StatCard label="Leads touched (range)" value={leadsTouched} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Leads w/out completed attempt (range)"
              value={leadsWithoutAttempt}
            />
            <StatCard label="Open Leads (all)" value={openLeads} />
            <StatCard
              label="Overdue scheduled (all)"
              value={overdueScheduled}
            />
            <StatCard
              label="Never attempted (all)"
              value={totalLeadsNeverAttempted}
            />
          </div>

          {advisoryNotes.length > 0 && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
              <div className="font-semibold">Heads up</div>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {advisoryNotes.map((note, idx) => (
                  <li key={idx}>{note}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Charts */}
          <div className="grid gap-6 lg:grid-cols-2">
            {/* Leads over time */}
            <div className="p-4 border rounded-2xl">
              <div className="mb-3 text-sm font-semibold">Leads over time</div>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={series}>
                    <defs>
                      <linearGradient
                        id="gLeadsFill"
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                      >
                        <stop
                          offset="5%"
                          stopColor={COLORS.leads}
                          stopOpacity={0.35}
                        />
                        <stop
                          offset="95%"
                          stopColor={COLORS.leads}
                          stopOpacity={0.05}
                        />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                    <YAxis allowDecimals={false} />
                    <Tooltip
                      contentStyle={{
                        borderRadius: 12,
                        border: "1px solid #e5e7eb",
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="leads"
                      name="Leads"
                      fill="url(#gLeadsFill)"
                      stroke={COLORS.leads}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Outcome breakdown */}
            <div className="p-4 border rounded-2xl">
              <div className="mb-3 text-sm font-semibold">
                Outcome breakdown
              </div>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={outcomes.map((d) => ({
                      outcome: d.outcome?.replace(/_/g, " "),
                      raw: d.outcome,
                      count: d.count,
                    }))}
                  >
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="outcome" tick={{ fontSize: 12 }} />
                    <YAxis allowDecimals={false} />
                    <Tooltip
                      contentStyle={{
                        borderRadius: 12,
                        border: "1px solid #e5e7eb",
                      }}
                    />
                    <Legend />
                    {/* Single bar with dynamic fill per outcome */}
                    <Bar dataKey="count" name="Count">
                      {outcomes.map((d, idx) => {
                        const key = (d.outcome || "").toUpperCase();
                        const color =
                          key === "ANSWERED"
                            ? COLORS.answered
                            : key === "VOICEMAIL"
                            ? COLORS.voicemail
                            : key === "NO_ANSWER"
                            ? COLORS.noAnswer
                            : key === "FAILED"
                            ? COLORS.failed
                            : key === "CANCELED"
                            ? COLORS.canceled
                            : COLORS.leads;
                        return <Cell key={`cell-${idx}`} fill={color} />;
                      })}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* Stacked: Answered vs others over time (optional, uses same timeseries) */}
          <div className="p-4 border rounded-2xl">
            <div className="mb-3 text-sm font-semibold">
              Daily outcomes (stacked)
            </div>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={series}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                  <YAxis allowDecimals={false} />
                  <Tooltip
                    contentStyle={{
                      borderRadius: 12,
                      border: "1px solid #e5e7eb",
                    }}
                  />
                  <Legend />
                  <Bar
                    dataKey="answered"
                    stackId="a"
                    name="Answered"
                    fill={COLORS.answered}
                  />
                  <Bar
                    dataKey="voicemail"
                    stackId="a"
                    name="Voicemail"
                    fill={COLORS.voicemail}
                  />
                  <Bar
                    dataKey="noAnswer"
                    stackId="a"
                    name="No Answer"
                    fill={COLORS.noAnswer}
                  />
                  <Bar
                    dataKey="failed"
                    stackId="a"
                    name="Failed"
                    fill={COLORS.failed}
                  />
                  <Bar
                    dataKey="canceled"
                    stackId="a"
                    name="Canceled"
                    fill={COLORS.canceled}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
