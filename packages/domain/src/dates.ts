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
