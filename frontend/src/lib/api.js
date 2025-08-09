const BASE = import.meta.env.VITE_API_BASE;
import { getToken } from './auth';

export async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}), Authorization: `Bearer ${getToken()}` };
  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
