# 011. Plans, members and memberships

- Status: accepted
- Date: 2026-11-25

## Decision

**Money.** Plan prices are stored in paise _before_ GST, with the GST slab in basis points (0, 5, 12, 18, 28%).
`priceBreakdown` adds GST (half-up) to price + joining fee. A membership copies the plan's prices when it is sold,
so later plan changes never alter what a member bought. The joining fee is charged on a member's first membership.

**Dates.** Membership dates are calendar dates (`YYYY-MM-DD`, Postgres `date`) in the gym's own time zone;
"today" is `todayIn(org.timezone)`. Start and end dates are inclusive. Month plans end the day before the same
date in the next period (15 Jan + 1 month → 14 Feb; 31 Jan + 1 month → 27 Feb, because 28 Feb is the
"same date" and the end is the day before).

**Statuses** (`@gym/domain` `canTransition`, the only place the rules live):
pending → active | trial | cancelled; trial → expired | cancelled; active → frozen | expired | cancelled;
frozen → active | cancelled; expired and cancelled are final. Renewing means selling a new membership, which must
start after any running one ends (no overlaps). Status updates use an optimistic guard on the previous status.

**Pauses.** Freezing adds the frozen days to the end date (limits per plan: number of pauses, days per pause).
Resuming early removes the unused days (`unfreezeSplit`); resuming on the same day also returns the pause.

**Plan change.** `prorateCredit` values the unused days (today counts as unused) with `allocate()`, so credit +
used always equals the price; joining fee and GST are not credited. The old membership is cancelled as
`changed_plan` and the new one starts today; billing receives `membership.plan_changed` with the credit.

**Upkeep job.** `runMembershipLifecycle` runs hourly (BullMQ job scheduler): starts pending memberships, resumes
finished pauses, expires memberships past their last day and publishes `membership.expired`. It is idempotent.

**System role.** Background jobs that must see all gyms use `withSystem` (`app_system`: NOLOGIN, BYPASSRLS, but
granted only `SELECT (id, timezone, deleted_at)` on organisations). All changes still run in `withTenant`.
Creating a BYPASSRLS role needs a privileged migration role; verify this on the staging database (A17).

**Imports.** CSV up to 10,000 rows / 1 MB, processed by a worker handler with one savepoint per row; failed rows
are reported (first 500) and never stop the rest. Imported memberships publish no billing event. The file is
deleted after processing. Only staff who look after every branch can import.

**Events for billing (A10).** `membership.created` (amounts), `membership.plan_changed` (credit),
`membership.cancelled`, `membership.expired`.
