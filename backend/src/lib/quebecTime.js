// lib/quebecTime.js
import moment from "moment-timezone";

export const QUEBEC_TZ = "America/Toronto";

/** Moment for now in a given tz (default Québec). */
export function nowIn(tz = QUEBEC_TZ) {
  return moment().tz(tz);
}

/** True if the current day is Sat/Sun in the given tz. */
export function isWeekend(tz = QUEBEC_TZ) {
  const d = nowIn(tz).day(); // 0=Sun ... 6=Sat
  return d === 0 || d === 6;
}

/** Format a Date in Québec for logging. */
export function formatInQuebec(date = new Date()) {
  return moment(date).tz(QUEBEC_TZ).format("YYYY-MM-DD HH:mm:ss z");
}
