// Calendar dates as "YYYY-MM-DD" strings: what a gym means by "the membership ends on 14 Feb", with no time
// zone attached. Arithmetic is done in UTC so it never shifts by a day.

const PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function toUtc(date: string): number {
  if (!isDate(date)) throw new RangeError(`not a calendar date: ${date}`);
  return Date.parse(`${date}T00:00:00Z`);
}

const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function isDate(value: string): boolean {
  if (!PATTERN.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && fromUtc(ms) === value;
}

export function addDays(date: string, days: number): string {
  return fromUtc(toUtc(date) + days * DAY_MS);
}

/** Same day-of-month `months` later; if that month is shorter, its last day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(date: string, months: number): string {
  const d = new Date(toUtc(date));
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return fromUtc(target.getTime());
}

/** Whole days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / DAY_MS);
}

/** Today's calendar date in an IANA time zone, e.g. todayIn("Asia/Kolkata"). */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** 0 = Sunday … 6 = Saturday. */
export const weekdayOf = (date: string): number => new Date(toUtc(date)).getUTCDay();

/** How far `timeZone` is ahead of UTC at instant `ms`, in ms. */
function zoneOffset(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return asUtc - (ms - (ms % 1000));
}

/**
 * The instant a wall-clock time ("HH:MM") on `date` happens in `timeZone`, e.g. 07:00 on 2026-12-01 in
 * Asia/Kolkata is 01:30Z. A time skipped by a daylight-saving change resolves to the hour after.
 */
export function zonedTime(date: string, time: string, timeZone: string): Date {
  const [h, m] = time.split(":").map(Number);
  if (!/^\d{2}:\d{2}$/.test(time) || h === undefined || m === undefined || h > 23 || m > 59)
    throw new RangeError(`not a time of day: ${time}`);
  const wall = toUtc(date) + (h * 60 + m) * 60_000;
  const early = wall - zoneOffset(wall, timeZone);
  const candidates = [early, wall - zoneOffset(early, timeZone)].sort((a, b) => a - b);
  // A time that happens twice (clocks go back) takes the first; one that never happens takes the later instant.
  const real = candidates.find((c) => c + zoneOffset(c, timeZone) === wall);
  return new Date(real ?? Math.max(...candidates));
}
