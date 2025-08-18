import moment from "moment-timezone";

import { getQuebecNowAsync, QUEBEC_TZ } from "./quebecTime.js";

const START = Number(process.env.CALL_WINDOW_START || 9); // 9 AM
const END = Number(process.env.CALL_WINDOW_END || 16); // 4 PM

/** Always returns Quebec TZ unless you intentionally override. */
export function pickTz(tz) {
  return tz && moment.tz.zone(tz) ? tz : QUEBEC_TZ;
}

/**
 * Get the next inside-window unix timestamp (seconds) in the given TZ.
 * Uses API-backed epoch seconds; avoids parsing human strings.
 */
export async function nextInsideWindowUnix(tz = QUEBEC_TZ) {
  const qnow = await getQuebecNowAsync(); // { unixNow, tz, ... }
  const now = moment.unix(qnow.unixNow).tz(pickTz(tz)); // reliable epoch-based

  const start = now.clone().hour(START).minute(0).second(0).millisecond(0);
  const end = now.clone().hour(END).minute(0).second(0).millisecond(0);

  let when;
  if (now.isBefore(start)) {
    // Before window → today at START
    when = start;
  } else if (now.isSameOrBefore(end)) {
    // Inside window → schedule 2 min from now if still in window
    const c = now.clone().add(2, "minutes");
    when = c.isSameOrBefore(end) ? c : start.add(1, "day");
  } else {
    // After window → tomorrow at START
    when = start.add(1, "day");
  }
  return when.unix(); // seconds
}
