import type { MembershipStatus } from "./membership";

/** Why a member may not come in. Codes are shown on the kiosk and at the desk. */
export const ENTRY_DENIALS = [
  "invalid_code",
  "code_already_used",
  "no_active_membership",
  "membership_paused",
  "wrong_branch",
  "dues_unpaid",
] as const;
export type EntryDenial = (typeof ENTRY_DENIALS)[number];

export interface EntryFacts {
  /** The gym's calendar date. */
  today: string;
  branchId: string;
  /** The member's memberships with the branches their plan is sold at (empty = every branch). */
  memberships: readonly {
    status: MembershipStatus;
    startDate: string;
    endDate: string;
    branchIds: readonly string[];
  }[];
  /** Unpaid invoices whose due date has passed. */
  overdueInvoices: number;
}

/**
 * The membership rules for entry, or null when the member may come in. A membership counts from its start date
 * even if the hourly job has not marked it active yet; a paused one does not count.
 */
export function entryDenial(facts: EntryFacts): EntryDenial | null {
  const today = facts.memberships.filter(
    (m) => m.startDate <= facts.today && m.endDate >= facts.today,
  );
  const running = today.filter((m) => ["active", "trial", "pending"].includes(m.status));
  if (!running.length)
    return today.some((m) => m.status === "frozen") ? "membership_paused" : "no_active_membership";
  if (!running.some((m) => !m.branchIds.length || m.branchIds.includes(facts.branchId)))
    return "wrong_branch";
  return facts.overdueInvoices > 0 ? "dues_unpaid" : null;
}
