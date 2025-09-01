import moment from "moment-timezone";

import {
  getQuebecNow,
  QUEBEC_TZ,
  isQuebecWeekend,
  getNextQuebecWeekdayUnix,
} from "./quebecTime.js";

// Window hours (local Québec time)
export const START = Number(process.env.CALL_WINDOW_START || 9); // e.g., 9 AM
export const END = Number(process.env.CALL_WINDOW_END || 19); // e.g., 7 PM
export const WINDOW_LEN_SECS = Math.max(0, END - START) * 3600;

/** Always returns Québec TZ unless intentionally overridden. */
export function pickTz(tz) {
  return tz && moment.tz.zone(tz) ? tz : QUEBEC_TZ;
}

export function nextInsideWindowUnixQuebec() {
  const qnow = getQuebecNow();
  const now = moment.unix(qnow.unixNow).tz(QUEBEC_TZ);

  if (isQuebecWeekend()) {
    return getNextQuebecWeekdayUnix();
  }

  const start = now.clone().hour(START).minute(0).second(0).millisecond(0);
  const end = now.clone().hour(END).minute(0).second(0).millisecond(0);

  let when;
  if (now.isBefore(start)) {
    when = start;
  } else if (now.isSameOrBefore(end)) {
    const c = now.clone().add(2, "minutes");
    when = c.isSameOrBefore(end) ? c : start.add(1, "day");
  } else {
    when = start.add(1, "day");
  }
  return when.unix();
}

export function nextInsideWindowUnix(tz = QUEBEC_TZ) {
  const qnow = getQuebecNow();
  const now = moment.unix(qnow.unixNow).tz(pickTz(tz));

  if (isQuebecWeekend()) {
    return getNextQuebecWeekdayUnix();
  }

  const start = now.clone().hour(START).minute(0).second(0).millisecond(0);
  const end = now.clone().hour(END).minute(0).second(0).millisecond(0);

  let when;
  if (now.isBefore(start)) {
    when = start;
  } else if (now.isSameOrBefore(end)) {
    const c = now.clone().add(2, "minutes");
    when = c.isSameOrBefore(end) ? c : start.add(1, "day");
  } else {
    when = start.add(1, "day");
  }
  return when.unix();
}
