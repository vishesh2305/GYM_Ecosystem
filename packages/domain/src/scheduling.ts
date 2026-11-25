import { addDays, daysBetween, weekdayOf } from "./dates";

export interface WeeklyPattern {
  /** 0 = Sunday … 6 = Saturday. */
  weekdays: readonly number[];
  startsOn: string;
  /** Inclusive; null = no end. */
  endsOn: string | null;
}

/** Calendar dates in [from, from + days) on which a weekly class takes place. */
export function occurrences(pattern: WeeklyPattern, from: string, days: number): string[] {
  const dates: string[] = [];
  for (let i = 0; i < days; i += 1) {
    const date = addDays(from, i);
    if (daysBetween(pattern.startsOn, date) < 0) continue;
    if (pattern.endsOn && daysBetween(date, pattern.endsOn) < 0) break;
    if (pattern.weekdays.includes(weekdayOf(date))) dates.push(date);
  }
  return dates;
}

/** Cancelling inside the window before the start (or after it) counts as a late cancellation. */
export const isLateCancel = (startsAt: Date, windowMinutes: number, now: Date): boolean =>
  now.getTime() > startsAt.getTime() - windowMinutes * 60_000;
