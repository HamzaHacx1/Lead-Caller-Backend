import React, { useState } from "react";

import { setToken } from "../lib/auth";

export default function Login({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    try {
      const res = await fetch(`${import.meta.env.VITE_API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const js = await res.json();
      if (!res.ok) throw new Error(js.error || "Login failed");
      setToken(js.token);
      onLogin?.();
    } catch (e) {
      setErr(e.message);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl bg-white p-6 shadow"
      >
        <h1 className="mb-4 text-xl font-semibold">Sign in</h1>
        {err && (
          <div className="mb-3 rounded bg-red-100 p-2 text-sm text-red-700">
            {err}
          </div>
        )}
        <input
          className="mb-3 w-full rounded border p-2"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          className="mb-4 w-full rounded border p-2"
          placeholder="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="w-full rounded bg-black p-2 text-white">
          Login
        </button>
      </form>
    </div>
  );
}
