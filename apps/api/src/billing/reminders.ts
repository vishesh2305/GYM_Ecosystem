import { withSystem, withTenant, type Database } from "@gym/db";
import { and, eq, inArray, isNull, lte, sql } from "@gym/db/orm";
import { invoices, memberships, organisations } from "@gym/db/schema";
import { addDays, daysBetween, todayIn } from "@gym/domain";
import { z } from "zod";
import { membershipExpired } from "../membership/events";
import { appendEvent, defineEvent } from "../platform/events";

/** Reminder n is due this many days after the invoice due date. */
export const REMINDER_DAYS = [0, 2, 5] as const;

/** Delivered by the notifications module (step A14) by SMS / WhatsApp / email. */
export const paymentReminderDue = defineEvent(
  "invoice.payment_reminder",
  z.object({
    invoiceId: z.uuid(),
    memberId: z.uuid(),
    attempt: z.number().int(),
    duePaise: z.number().int(),
    dueDate: z.iso.date(),
  }),
);

/**
 * Hourly, per gym and in its time zone: raise the next reminder for each unpaid invoice whose time has come,
 * and once an invoice is `graceDays` overdue, expire the membership it pays for. Idempotent.
 */
export async function runPaymentReminders(db: Database, graceDays: number, now: Date = new Date()) {
  const orgs = await withSystem(db, (tx) =>
    tx
      .select({ id: organisations.id, timezone: organisations.timezone })
      .from(organisations)
      .where(isNull(organisations.deletedAt)),
  );
  const totals = { reminders: 0, expired: 0 };
  for (const org of orgs) {
    const today = todayIn(org.timezone, now);
    await withTenant(db, org.id, async (tx) => {
      const unpaid = await tx
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.kind, "invoice"),
            inArray(invoices.status, ["issued", "partially_paid"]),
            lte(invoices.dueDate, today),
          ),
        );
      for (const invoice of unpaid) {
        const overdue = daysBetween(invoice.dueDate, today);
        const nextAt = REMINDER_DAYS[invoice.remindersSent];
        if (nextAt !== undefined && overdue >= nextAt) {
          // Claim this step: if another run already raised it, the update matches nothing.
          const claimed = await tx
            .update(invoices)
            .set({ remindersSent: invoice.remindersSent + 1, lastReminderAt: now })
            .where(
              and(eq(invoices.id, invoice.id), eq(invoices.remindersSent, invoice.remindersSent)),
            )
            .returning({ id: invoices.id });
          if (claimed.length)
            await appendEvent(
              tx,
              paymentReminderDue,
              {
                invoiceId: invoice.id,
                memberId: invoice.memberId,
                attempt: invoice.remindersSent + 1,
                duePaise: invoice.totalPaise - invoice.paidPaise,
                dueDate: invoice.dueDate,
              },
              org.id,
            );
          totals.reminders += claimed.length;
        }
        if (overdue >= graceDays && invoice.membershipId) {
          const expired = await tx
            .update(memberships)
            // Ends yesterday, but never before it started.
            .set({
              status: "expired",
              endDate: sql`greatest(${memberships.startDate}, ${addDays(today, -1)}::date)`,
            })
            .where(
              and(
                eq(memberships.id, invoice.membershipId),
                inArray(memberships.status, ["active", "trial"]),
              ),
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
        }
      }
    });
  }
  return totals;
}
