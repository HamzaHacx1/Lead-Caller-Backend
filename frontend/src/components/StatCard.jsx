import React from "react";
export default function StatCard({ label, value }) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow">
      <div className="text-sm text-slate-500">{label}</div>
      <div className="mt-1 text-3xl font-semibold">{value}</div>
    </div>
  );
}
