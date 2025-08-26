export const QUEBEC_TZ = "America/Toronto";

/**
 * Get Québec local time using server time (DST-safe via Intl and IANA tz).
 * Returns: { tz, year, month, day, hour, minute, second, abbr, label, unixNow }
 */
export function getQuebecNow() {
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
    minute: Number(parts.minuteWare),
    second: Number(parts.second),
    abbr: parts.timeZoneName,
    label,
    unixNow: Math.floor(Date.now() / 1000),
  };
}

/**
 * True if current Québec local hour is within [startHour, endHour).
 */
export function isInsideQuebecWindow(startHour, endHour) {
  const { hour } = getQuebecNow();
  return hour >= startHour && hour < endHour;
}

/**
 * Format any Date into Québec local time (uses Intl; no network required).
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
