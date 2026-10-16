'use strict';
// Wall-clock arithmetic in an IANA time zone (daylight saving handled) and the next run of a schedule.
const DAY_MS = 86400000;
const DAYS = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7 };
const formats = new Map();
function formatter(timeZone) {
  let format = formats.get(timeZone);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch (_error) { throw new Error(`Unknown time zone: ${timeZone}.`); }
    formats.set(timeZone, format);
  }
  return format;
}
function checkTimeZone(timeZone) { if (typeof timeZone !== 'string' || !timeZone) throw new Error('timeZone must be an IANA time zone name.'); formatter(timeZone); return timeZone; }
function partsOf(ms, timeZone) {
  const p = Object.fromEntries(formatter(timeZone).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, second: +p.second };
}
/** Offset of the zone from UTC, in ms, at the instant `ms` (positive east of Greenwich). */
function offsetAt(ms, timeZone) {
  const p = partsOf(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
const pad = (n) => String(n).padStart(2, '0');
/** Calendar date `YYYY-MM-DD` of an instant in the zone. */
function localDate(ms, timeZone) { const p = partsOf(ms, timeZone); return `${p.year}-${pad(p.month)}-${pad(p.day)}`; }
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
/** 1 = Monday … 7 = Sunday for a `YYYY-MM-DD` date. */
function weekday(date) { const d = new Date(`${date}T12:00:00Z`).getUTCDay(); return d === 0 ? 7 : d; }
/**
 * The instant at which the wall clock of `timeZone` reads `hour:minute` on `date`.
 * A time that happens twice (clocks go back) is the first occurrence; a time that does not exist
 * (clocks go forward) is read with the offset in force before the change, i.e. it lands after the gap.
 */
function zonedTime(date, hour, minute, timeZone) {
  const [y, m, d] = date.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, hour, minute, 0);
  const before = offsetAt(wall - DAY_MS, timeZone);
  const valid = [...new Set([before, offsetAt(wall + DAY_MS, timeZone)])].map((o) => wall - o).filter((t) => offsetAt(t, timeZone) === wall - t);
  return valid.length ? Math.min(...valid) : wall - before;
}
function normalizeSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') throw new Error('schedule is required.');
  if (schedule.type === 'interval') {
    if (!Number.isFinite(schedule.everyMs) || schedule.everyMs <= 0) throw new Error('interval schedule needs a positive everyMs.');
    return { type: 'interval', everyMs: schedule.everyMs };
  }
  if (schedule.type !== 'daily' && schedule.type !== 'weekly') throw new Error('schedule.type must be daily, weekly or interval.');
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(schedule.at));
  if (!match) throw new Error('schedule.at must be HH:MM (24 hours).');
  const result = { type: schedule.type, hour: +match[1], minute: +match[2] };
  if (schedule.type === 'weekly') {
    const raw = schedule.days ?? schedule.day;
    const days = (Array.isArray(raw) ? raw : [raw]).map((v) => typeof v === 'string' ? DAYS[v.toLowerCase()] : v);
    if (!days.length || days.some((v) => !Number.isInteger(v) || v < 1 || v > 7)) throw new Error('weekly schedule needs day(s): 1 (Monday) to 7 (Sunday) or day names.');
    result.days = [...new Set(days)].sort();
  }
  return result;
}
/** First run strictly after `after` (ms). `schedule` is as given to the scheduler. */
function nextRun(schedule, after, timeZone = 'UTC') {
  const s = normalizeSchedule(schedule);
  if (s.type === 'interval') return after + s.everyMs;
  checkTimeZone(timeZone);
  const start = localDate(after, timeZone);
  for (let i = 0; i <= 8; i += 1) {
    const date = addDays(start, i);
    if (s.type === 'weekly' && !s.days.includes(weekday(date))) continue;
    const t = zonedTime(date, s.hour, s.minute, timeZone);
    if (t > after) return t;
  }
  throw new Error('No next run found.');
}
module.exports = { checkTimeZone, normalizeSchedule, nextRun, zonedTime, localDate };
