import { withSystem, withTenant, type Database, type Tx } from "@gym/db";
import { and, eq, gt, inArray, isNull, lte, sql } from "@gym/db/orm";
import {
  autopayMandates,
  bookings,
  checkIns,
  classSessions,
  members,
  memberships,
  organisations,
} from "@gym/db/schema";
import { addDays, todayIn } from "@gym/domain";
import { paymentFailed } from "../billing/payments.service";
import { paymentReminderDue } from "../billing/reminders";
import { defineHandler } from "../platform/events";
import { bookingPromoted } from "../scheduling/bookings";
import { sessionCancelled } from "../scheduling/timetable";
import { notify } from "./delivery";

/** Class reminders go out this long before the start. */
export const CLASS_REMINDER_HOURS = 2;
/** A member with a running membership who has not come in for this many days gets a "we miss you". */
export const INACTIVE_DAYS = 7;
/** Membership renewal reminders, in days before the last day. */
const RENEWAL_REMINDER_DAYS = [7, 3, 1] as const;

async function memberName(tx: Tx, memberId: string): Promise<string> {
  const [m] = await tx.select({ name: members.name }).from(members).where(eq(members.id, memberId));
  return m?.name ?? "";
}

async function gymName(tx: Tx): Promise<string> {
  const [org] = await tx.select({ name: organisations.name }).from(organisations);
  return org?.name ?? "";
}

// Event-driven journeys: each runs in the event's tenant transaction, once per event (the dispatcher's marker)
// and once per trigger (the dedupe key), so a redelivered event never sends twice.

export const notifyWaitlistPromoted = defineHandler({
  name: "notify-waitlist-promoted",
  event: bookingPromoted,
  async handle(p, { tx, event }) {
    await notify(tx, {
      tenantId: event.tenantId ?? "",
      memberId: p.memberId,
      key: "waitlist_promoted",
      vars: { name: await memberName(tx, p.memberId), className: p.name, startsAt: p.startsAt },
      dedupeKey: `waitlist_promoted:${p.bookingId}`,
      expiresAt: new Date(p.startsAt),
    });
  },
});

export const notifyClassCancelled = defineHandler({
  name: "notify-class-cancelled",
  event: sessionCancelled,
  async handle(p, { tx, event }) {
    for (const memberId of p.memberIds)
      await notify(tx, {
        tenantId: event.tenantId ?? "",
        memberId,
        key: "class_cancelled",
        vars: {
          name: await memberName(tx, memberId),
          className: p.name,
          startsAt: p.startsAt,
          reason: p.reason,
        },
        dedupeKey: `class_cancelled:${p.sessionId}:${memberId}`,
        expiresAt: new Date(p.startsAt),
      });
  },
});

export const notifyPaymentDue = defineHandler({
  name: "notify-payment-due",
  event: paymentReminderDue,
  async handle(p, { tx, event }) {
    await notify(tx, {
      tenantId: event.tenantId ?? "",
      memberId: p.memberId,
      key: "payment_due",
      vars: {
        name: await memberName(tx, p.memberId),
        gym: await gymName(tx),
        amountPaise: p.duePaise,
        dueDate: p.dueDate,
      },
      dedupeKey: `payment_due:${p.invoiceId}:${p.attempt}`,
    });
  },
});

export const notifyPaymentFailed = defineHandler({
  name: "notify-payment-failed",
  event: paymentFailed,
  async handle(p, { tx, event }) {
    await notify(tx, {
      tenantId: event.tenantId ?? "",
      memberId: p.memberId,
      key: "payment_failed",
      vars: {
        name: await memberName(tx, p.memberId),
        gym: await gymName(tx),
        amountPaise: p.amountPaise,
      },
      dedupeKey: `payment_failed:${p.paymentId}`,
    });
  },
});

export const notificationHandlers = [
  notifyWaitlistPromoted,
  notifyClassCancelled,
  notifyPaymentDue,
  notifyPaymentFailed,
];

// Scheduled journeys: found by looking at the data, so they also cover changes made without an event.

/** Running memberships ending in 7 or 3 days or tomorrow, unless already renewed or paid by AutoPay. */
async function renewalsDue(tx: Tx, tenantId: string, today: string, gym: string) {
  let queued = 0;
  for (const days of RENEWAL_REMINDER_DAYS) {
    const ending = await tx
      .select({ membership: memberships, name: members.name })
      .from(memberships)
      .innerJoin(members, eq(members.id, memberships.memberId))
      .where(
        and(
          inArray(memberships.status, ["active", "trial"]),
          eq(memberships.endDate, addDays(today, days)),
          isNull(members.deletedAt),
          sql`not exists (
            select 1 from ${memberships} next
            where next.member_id = ${memberships.memberId} and next.id <> ${memberships.id}
              and next.start_date > ${memberships.startDate}
              and next.status in ('pending', 'trial', 'active')
          )`,
          sql`not exists (
            select 1 from ${autopayMandates} a
            where a.member_id = ${memberships.memberId} and a.status = 'active'
          )`,
        ),
      );
    for (const { membership: m, name } of ending)
      if (
        await notify(tx, {
          tenantId,
          memberId: m.memberId,
          key: "renewal_due",
          vars: { name, gym, plan: m.planName, endDate: m.endDate },
          dedupeKey: `renewal_due:${m.id}:${days}`,
        })
      )
        queued++;
  }
  return queued;
}

/** Confirmed places in classes starting within the next CLASS_REMINDER_HOURS. */
async function classReminders(tx: Tx, tenantId: string, now: Date) {
  const soon = await tx
    .select({ booking: bookings, session: classSessions, name: members.name })
    .from(bookings)
    .innerJoin(classSessions, eq(classSessions.id, bookings.sessionId))
    .innerJoin(members, eq(members.id, bookings.memberId))
    .where(
      and(
        eq(bookings.status, "confirmed"),
        eq(classSessions.status, "scheduled"),
        gt(classSessions.startsAt, now),
        lte(classSessions.startsAt, new Date(now.getTime() + CLASS_REMINDER_HOURS * 3_600_000)),
      ),
    );
  let queued = 0;
  for (const { booking, session, name } of soon)
    if (
      await notify(tx, {
        tenantId,
        memberId: booking.memberId,
        key: "class_reminder",
        vars: { name, className: session.name, startsAt: session.startsAt.toISOString() },
        dedupeKey: `class_reminder:${booking.id}`,
        expiresAt: session.startsAt,
      })
    )
      queued++;
  return queued;
}

/**
 * Members with a running membership whose last visit (or start, if they never came) is INACTIVE_DAYS or more
 * ago. Once per absence: the dedupe key carries the last visit, so the next nudge needs a new visit first.
 */
async function inactiveMembers(tx: Tx, tenantId: string, today: string, now: Date, gym: string) {
  const cutoff = new Date(now.getTime() - INACTIVE_DAYS * 86_400_000);
  const lastVisit = sql<Date | null>`(select max(${checkIns.checkedInAt}) from ${checkIns} where ${checkIns.memberId} = ${members.id})`;
  const idle = await tx
    .select({ id: members.id, name: members.name, startDate: memberships.startDate, lastVisit })
    .from(memberships)
    .innerJoin(members, eq(members.id, memberships.memberId))
    .where(
      and(
        eq(memberships.status, "active"),
        lte(memberships.startDate, addDays(today, -INACTIVE_DAYS)),
        isNull(members.deletedAt),
        sql`coalesce(${lastVisit}, ${memberships.startDate}::timestamptz) <= ${cutoff.toISOString()}`,
      ),
    );
  let queued = 0;
  for (const m of idle) {
    const since = m.lastVisit ? new Date(m.lastVisit).toISOString() : `start:${m.startDate}`;
    if (
      await notify(tx, {
        tenantId,
        memberId: m.id,
        key: "inactive",
        vars: { name: m.name, gym },
        dedupeKey: `inactive:${m.id}:${since}`,
      })
    )
      queued++;
  }
  return queued;
}

/** Every 15 minutes, per gym in its own time zone: renewal reminders, class reminders and "we miss you". */
export async function runJourneys(db: Database, now: Date = new Date()) {
  const orgs = await withSystem(db, (tx) =>
    tx
      .select({ id: organisations.id, timezone: organisations.timezone })
      .from(organisations)
      .where(isNull(organisations.deletedAt)),
  );
  const totals = { renewals: 0, classReminders: 0, inactive: 0 };
  for (const org of orgs) {
    await withTenant(db, org.id, async (tx) => {
      const today = todayIn(org.timezone, now);
      const gym = await gymName(tx);
      totals.renewals += await renewalsDue(tx, org.id, today, gym);
      totals.classReminders += await classReminders(tx, org.id, now);
      totals.inactive += await inactiveMembers(tx, org.id, today, now, gym);
    });
  }
  return totals;
}
