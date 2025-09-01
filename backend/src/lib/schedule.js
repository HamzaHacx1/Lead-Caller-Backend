// lib/schedule.js
import moment from "moment-timezone";

import { nowIn, isWeekend, QUEBEC_TZ } from "./quebecTime.js";

function toHour(val, fallback) {
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : fallback;
}

export let START = toHour(process.env.CALL_WINDOW_START, 9); // 0..23
export let END = toHour(process.env.CALL_WINDOW_END, 19); // 0..23

if (END <= START) {
  console.warn(`[schedule] Invalid window ${START}–${END}, forcing 9–19`);
  START = 9;
  END = 19;
}

/** Window length in seconds (non-negative). */
export const WINDOW_LEN_SECS = Math.max(0, (END - START) * 3600);

/** Always returns a valid tz. */
export function pickTz(tz) {
  return tz && moment.tz.zone(tz) ? tz : QUEBEC_TZ;
}

/** Next timestamp inside [START, END) for the given tz. */
export function nextInsideWindowUnix(tz = QUEBEC_TZ) {
  const zone = pickTz(tz);
  const now = nowIn(zone);

  if (isWeekend(zone)) {
    // Move forward to next weekday @ START
    let when = now
      .clone()
      .add(1, "day")
      .hour(START)
      .minute(0)
      .second(0)
      .millisecond(0);
    while (when.day() === 0 || when.day() === 6) when = when.add(1, "day");
    return when.unix();
  }

  const start = now.clone().hour(START).minute(0).second(0).millisecond(0);
  const end = now.clone().hour(END).minute(0).second(0).millisecond(0);

  if (now.isBefore(start)) return start.unix();

  if (now.isSameOrBefore(end)) {
    const cand = now.clone().add(2, "minutes");
    return cand.isSameOrBefore(end)
      ? cand.unix()
      : start.clone().add(1, "day").unix(); // spill to next day START
  }

  return start.clone().add(1, "day").unix();
}

/** Next day inside window (02 min after START), skipping weekends. */
export function nextDayInsideWindowUnix(tz = QUEBEC_TZ) {
  const zone = pickTz(tz);
  let when = nowIn(zone)
    .add(1, "day")
    .hour(START)
    .minute(2)
    .second(0)
    .millisecond(0);
  while (when.day() === 0 || when.day() === 6) when = when.add(1, "day");
  return when.unix();
}
