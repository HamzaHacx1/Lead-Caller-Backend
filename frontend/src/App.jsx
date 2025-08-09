import { useEffect, useState } from "react";
import React from "react";

import { isAuthed, setToken } from "./lib/auth";
import Dashboard from "./pages/Dashboard";
import Attempts from "./pages/Attempts";
import Login from "./pages/Login";
import Leads from "./pages/Leads";

const tabs = [
  { key: "dashboard", label: "Dashboard", component: Dashboard },
  { key: "leads", label: "Leads", component: Leads },
  { key: "attempts", label: "Attempts", component: Attempts },
];

export default function App() {
  const [authed, setAuthed] = useState(isAuthed());
  const [tab, setTab] = useState("dashboard");
  useEffect(() => setAuthed(isAuthed()), []);

  if (!authed) return <Login onLogin={() => setAuthed(true)} />;

  const Comp = tabs.find((t) => t.key === tab).component;
  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Lead Dialer</h1>
        <button
          onClick={() => {
            setToken("");
            setAuthed(false);
          }}
          className="rounded bg-slate-200 px-3 py-2 text-sm"
        >
          Logout
        </button>
      </div>

      <div className="mb-4 flex gap-2">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-xl px-4 py-2 ${
              tab === t.key
                ? "bg-black text-white"
                : "bg-white text-black border"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <Comp />
    </div>
  );
}
