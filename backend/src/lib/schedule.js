import moment from 'moment-timezone';

const START = Number(process.env.CALL_WINDOW_START || 9);
const END = Number(process.env.CALL_WINDOW_END || 16);
const DEFAULT_TZ = process.env.DEFAULT_TZ || 'America/Toronto';

export function pickTz(tz) { return tz && moment.tz.zone(tz) ? tz : DEFAULT_TZ; }

export function nextInsideWindowUnix(tz) {
  const now = moment().tz(pickTz(tz));
  const start = now.clone().hour(START).minute(0).second(0).millisecond(0);
  const end = now.clone().hour(END).minute(0).second(0).millisecond(0);
  let when;
  if (now.isBefore(start)) when = start;
  else if (now.isSameOrBefore(end)) {
    const c = now.clone().add(2, 'minutes');
    when = c.isSameOrBefore(end) ? c : start.add(1, 'day');
  } else when = start.add(1, 'day');
  return when.unix();
}
