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
