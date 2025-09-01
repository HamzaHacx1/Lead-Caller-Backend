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
    minute: "2-digit", // Fixed typo from minuteWare
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
 * True if current Québec local hour is within [startHour, endHour).
 */
export function isInsideQuebecWindow(startHour, endHour) {
  const { hour } = getQuebecNow();
  return hour >= startHour && hour < endHour;
}

/**
 * True if the current day is a weekend (Saturday or Sunday) in Québec time.
 */
export function isQuebecWeekend() {
  const { day } = getQuebecNow();
  return day === 0 || day === 6; // 0 = Sunday, 6 = Saturday
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

/**
 * Get the next weekday Unix timestamp within the Québec window.
 * Skips weekends and respects the 9 AM–7 PM window.
 */
export function getNextQuebecWeekdayUnix() {
  let now = moment().tz(QUEBEC_TZ);
  let when = now.clone();
  while (when.day() === 0 || when.day() === 6) {
    when.add(1, "day").hour(START).minute(0).second(0).millisecond(0);
  }
  const start = when.clone().hour(START).minute(0).second(0).millisecond(0);
  const end = when.clone().hour(END).minute(0).second(0).millisecond(0);
  return now.isSameOrBefore(end) ? now.add(2, "minutes").unix() : start.unix();
}
