// Real-time Quebec time via API with safe fallbacks.
// Works in Node 18+ (global fetch). If you're on older Node, install node-fetch and import it here.

export const QUEBEC_TZ = "America/Toronto";

// You can override the API endpoint via env if you like.
const DEFAULT_API =
  process.env.TIME_API_URL ||
  "https://worldtimeapi.org/api/timezone/America/Toronto";

const FETCH_TIMEOUT_MS = Number(process.env.TIME_API_TIMEOUT_MS || 2500);
const RETRIES = 1; // total attempts = 1 + RETRIES

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

/**
 * Parse worldtimeapi.org response into our normalized shape.
 * Minimal fields used by the app: hour, label, unixNow, tz, abbr.
 */
function parseWTA(json) {
  // worldtimeapi.org fields:
  //  - datetime (local ISO), utc_datetime, abbreviation (EST/EDT)
  //  - unixtime (seconds), utc_offset (+-HH:MM), dst (bool)
  //  - timezone ("America/Toronto")
  const tz = json?.timezone || QUEBEC_TZ;
  const abbr = json?.abbreviation || "ET";
  const unixNow = Number(json?.unixtime) || Math.floor(Date.now() / 1000);

  // Make a label like "2025-08-15 09:42:33 EDT"
  const localISO = String(json?.datetime || "");
  let year, month, day, hour, minute, second;

  // local ISO example: "2025-08-15T09:42:33.123456-04:00"
  if (localISO) {
    try {
      year = Number(localISO.slice(0, 4));
      month = Number(localISO.slice(5, 7));
      day = Number(localISO.slice(8, 10));
      hour = Number(localISO.slice(11, 13));
      minute = Number(localISO.slice(14, 16));
      second = Number(localISO.slice(17, 19));
    } catch {
      /* fall back below */
    }
  }

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(second)
  ) {
    // Fallback to building from unix + Intl
    const d = new Date(unixNow * 1000);
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "short",
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(d).map((p) => [p.type, p.value])
    );
    year = Number(parts.year);
    month = Number(parts.month);
    day = Number(parts.day);
    hour = Number(parts.hour);
    minute = Number(parts.minute);
    second = Number(parts.second);
  }

  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  const HH = String(hour).padStart(2, "0");
  const MM = String(minute).padStart(2, "0");
  const SS = String(second).padStart(2, "0");
  const label = `${year}-${mm}-${dd} ${HH}:${MM}:${SS} ${abbr}`;

  return {
    tz,
    year,
    month,
    day,
    hour,
    minute,
    second,
    abbr,
    label,
    unixNow,
  };
}

/**
 * Fallback local compute (no network). DST-safe via Intl and IANA tz.
 */
function localFallback() {
  const d = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: QUEBEC_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(d).map((p) => [p.type, p.value])
  );
  const label = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.timeZoneName}`;
  return {
    tz: QUEBEC_TZ,
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    abbr: parts.timeZoneName,
    label,
    unixNow: Math.floor(Date.now() / 1000),
  };
}

/**
 * Get real-time Quebec time from an external API (with fallback).
 * Returns: { tz, year, month, day, hour, minute, second, abbr, label, unixNow }
 */
export async function getQuebecNowAsync() {
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetchWithTimeout(DEFAULT_API, FETCH_TIMEOUT_MS);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      return parseWTA(json);
    } catch (e) {
      lastErr = e;
    }
  }
  // fallback if API unreachable/slow
  if (process.env.NODE_ENV !== "production") {
    console.warn(
      "[quebecTime] using local fallback:",
      lastErr?.message || lastErr
    );
  }
  return localFallback();
}

/**
 * True if current Quebec local hour is within [startHour, endHour)
 * Uses the API-backed clock when available.
 */
export async function isInsideQuebecWindowAsync(startHour, endHour) {
  const { hour } = await getQuebecNowAsync();
  return hour >= startHour && hour < endHour;
}

/**
 * Format any Date into Quebec local time (uses Intl; formatting doesn’t need API).
 */
export function formatInQuebec(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: QUEBEC_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
  return fmt.format(date);
}
