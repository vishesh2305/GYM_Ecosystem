import { withSystem, withTenant, type Database } from "@gym/db";
import { and, eq, inArray, isNull, lt, lte } from "@gym/db/orm";
import { membershipFreezes, memberships, organisations } from "@gym/db/schema";
import { todayIn } from "@gym/domain";
import { appendEvent } from "../platform/events";
import { membershipExpired } from "./events";

/**
 * Keeps memberships on schedule, per gym, in the gym's own time zone. Safe to run any number of times:
 * 1. pending memberships whose start date has come become active (or trial),
 * 2. pauses past their planned end are resumed (all paused days were used, so the end date stays),
 * 3. active and trial memberships past their last day expire, with a membership.expired event.
 */
export async function runMembershipLifecycle(db: Database, now: Date = new Date()) {
  const orgs = await withSystem(db, (tx) =>
    tx
      .select({ id: organisations.id, timezone: organisations.timezone })
      .from(organisations)
      .where(isNull(organisations.deletedAt)),
  );
  const totals = { started: 0, resumed: 0, expired: 0 };

  for (const org of orgs) {
    const today = todayIn(org.timezone, now);
    await withTenant(db, org.id, async (tx) => {
      const pending = await tx
        .select({ id: memberships.id, isTrial: memberships.isTrial })
        .from(memberships)
        .where(and(eq(memberships.status, "pending"), lte(memberships.startDate, today)));
      for (const m of pending) {
        await tx
          .update(memberships)
          .set({ status: m.isTrial ? "trial" : "active" })
          .where(eq(memberships.id, m.id));
      }
      totals.started += pending.length;

      const finished = await tx
        .update(membershipFreezes)
        .set({ endedOn: membershipFreezes.plannedEndsOn })
        .where(and(isNull(membershipFreezes.endedOn), lt(membershipFreezes.plannedEndsOn, today)))
        .returning({ membershipId: membershipFreezes.membershipId });
      if (finished.length) {
        await tx
          .update(memberships)
          .set({ status: "active" })
          .where(
            and(
              eq(memberships.status, "frozen"),
              inArray(
                memberships.id,
                finished.map((f) => f.membershipId),
              ),
            ),
          );
      }
      totals.resumed += finished.length;

      const expired = await tx
        .update(memberships)
        .set({ status: "expired" })
        .where(
          and(inArray(memberships.status, ["active", "trial"]), lt(memberships.endDate, today)),
        )
        .returning({
          id: memberships.id,
          memberId: memberships.memberId,
          endDate: memberships.endDate,
        });
      for (const m of expired) {
        await appendEvent(
          tx,
          membershipExpired,
          { membershipId: m.id, memberId: m.memberId, endDate: m.endDate },
          org.id,
        );
      }
      totals.expired += expired.length;
    });
  }
  return totals;
}
