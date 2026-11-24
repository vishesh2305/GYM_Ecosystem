import { daysBetween } from "./dates";
import { allocate } from "./money";
export const MEMBERSHIP_STATUSES = [
  "pending",
  "trial",
  "active",
  "frozen",
  "expired",
  "cancelled",
] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/**
 * pending → active | trial (start date reached) | cancelled
 * trial   → expired | cancelled            (converting a trial = selling a new, paid membership)
 * active  → frozen | expired | cancelled
 * frozen  → active (unfrozen) | cancelled  (a frozen membership cannot expire: freezing extends it)
 * expired, cancelled: final                (renewing = selling a new membership)
 */
const ALLOWED: Readonly<Record<MembershipStatus, readonly MembershipStatus[]>> = {
  pending: ["active", "trial", "cancelled"],
  trial: ["expired", "cancelled"],
  active: ["frozen", "expired", "cancelled"],
  frozen: ["active", "cancelled"],
  expired: [],
  cancelled: [],
};

export const canTransition = (from: MembershipStatus, to: MembershipStatus): boolean =>
  ALLOWED[from].includes(to);

/** Statuses that still give access now or later. */
export const LIVE_STATUSES: readonly MembershipStatus[] = ["pending", "trial", "active", "frozen"];

export function initialStatus(input: {
  startDate: string;
  today: string;
  isTrial: boolean;
}): MembershipStatus {
  if (input.startDate > input.today) return "pending";
  return input.isTrial ? "trial" : "active";
}

/** A freeze covers `days` days from `startsOn`. Coming back on `today` uses the days before today. */
export function unfreezeSplit(input: { startsOn: string; days: number; today: string }): {
  usedDays: number;
  unusedDays: number;
} {
  const usedDays = Math.min(input.days, Math.max(0, daysBetween(input.startsOn, input.today)));
  return { usedDays, unusedDays: input.days - usedDays };
}

/**
 * Value of the unused days of a membership (today counts as unused: the new plan starts today).
 * Uses allocate(), so credit + used always equals the price exactly. Joining fees and GST are not credited.
 */
export function prorateCredit(input: {
  pricePaise: number;
  startDate: string;
  endDate: string;
  today: string;
}): {
  totalDays: number;
  unusedDays: number;
  creditPaise: number;
} {
  const totalDays = daysBetween(input.startDate, input.endDate) + 1;
  const from = input.today > input.startDate ? input.today : input.startDate;
  const unusedDays = Math.min(totalDays, Math.max(0, daysBetween(from, input.endDate) + 1));
  const [creditPaise = 0] = allocate(input.pricePaise, [unusedDays, totalDays - unusedDays]);
  return { totalDays, unusedDays, creditPaise };
}
