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
} from "recharts";
import React, { useEffect, useMemo, useState } from "react";

import StatCard from "../components/StatCard";
import { api } from "../lib/api";

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
    if (!series?.length) return 0;
    return series.reduce((acc, d) => acc + (d.leads || 0), 0);
  }, [series]);

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
            <option value="FAILED">Failed</option>
            <option value="NO_ANSWER">No Answer</option>
            <option value="VOICEMAIL">Voicemail</option>
            <option value="SCHEDULED">Scheduled</option>
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
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <StatCard label="Leads (range)" value={totalLeads} />
            <StatCard label="Leads Today" value={stats?.todayLeads ?? 0} />
            <StatCard label="Answered" value={stats?.answered ?? 0} />
            <StatCard label="Failed" value={stats?.failed ?? 0} />
            <StatCard label="No Answer" value={stats?.noAnswer ?? 0} />
            <StatCard label="Voicemail" value={stats?.voicemail ?? 0} />
          </div>

          {/* Charts */}
          <div className="grid gap-6 lg:grid-cols-2">
            {/* Leads over time */}
            <div className="p-4 border rounded-2xl">
              <div className="mb-3 text-sm font-semibold">Leads over time</div>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={series}>
                    <defs>
                      <linearGradient id="gLeads" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopOpacity={0.45} />
                        <stop offset="95%" stopOpacity={0.05} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                    <YAxis allowDecimals={false} />
                    <Tooltip />
                    <Area
                      type="monotone"
                      dataKey="leads"
                      fillOpacity={1}
                      fill="url(#gLeads)"
                      strokeWidth={2}
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
                      outcome: d.outcome?.replace("_", " "),
                      count: d.count,
                    }))}
                  >
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="outcome" tick={{ fontSize: 12 }} />
                    <YAxis allowDecimals={false} />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="count" name="Count" />
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
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="answered" stackId="a" name="Answered" />
                  <Bar dataKey="voicemail" stackId="a" name="Voicemail" />
                  <Bar dataKey="noAnswer" stackId="a" name="No Answer" />
                  <Bar dataKey="failed" stackId="a" name="Failed" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
