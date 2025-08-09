import { useEffect, useState } from "react";
import React from "react";

import StatCard from "../components/StatCard";
import { api } from "../lib/api";

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  useEffect(() => {
    api("/metrics/summary").then(setStats).catch(console.error);
  }, []);
  if (!stats) return <div>Loading...</div>;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      <StatCard label="Leads Today" value={stats.todayLeads} />
      <StatCard label="Answered" value={stats.answered} />
      <StatCard label="Failed" value={stats.failed} />
      <StatCard label="No Answer" value={stats.noAnswer} />
      <StatCard label="Voicemail" value={stats.voicemail} />
    </div>
  );
}
