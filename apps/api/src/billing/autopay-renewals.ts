import { withSystem, withTenant, type Database, type Tx } from "@gym/db";
import { and, desc, eq, inArray, isNull } from "@gym/db/orm";
import {
  autopayMandates,
  invoices,
  members,
  memberships,
  organisations,
  payments,
} from "@gym/db/schema";
import { addDays, daysBetween, LIVE_STATUSES, todayIn } from "@gym/domain";
import { HttpException } from "@nestjs/common";
import { sellPlan } from "../membership/memberships.service";
import type { PaymentGateway } from "./gateway";
import { appendEvent } from "../platform/events";
import { lockPayableInvoice, paymentFailed } from "./payments.service";

/** Renew this many days before the last day: UPI AutoPay notifies the member a day before each charge. */
export const RENEW_DAYS_BEFORE = 3;
/** Charge tries per renewal invoice, at least RETRY_AFTER_MS apart. After that the reminders take over. */
export const MAX_CHARGE_ATTEMPTS = 3;
export const RETRY_AFTER_MS = 20 * 3_600_000;

type Mandate = typeof autopayMandates.$inferSelect;
type Member = typeof members.$inferSelect;
type Totals = {
  renewed: number;
  skipped: number;
  charged: number;
  failed: number;
  /** Gateway errors, logged by the worker. */
  errors: string[];
};

/**
 * Hourly, per gym and in its time zone, for every member with AutoPay on:
 * 1. a running (not trial, not paused) membership ending within RENEW_DAYS_BEFORE days is renewed on the same
 *    plan from the day after it ends; the usual invoice follows from membership.created;
 * 2. unpaid renewal invoices within the approved limit are charged to the mandate. The outcome arrives by
 *    webhook. Failures retry up to MAX_CHARGE_ATTEMPTS; meanwhile the payment reminders run as for any invoice.
 * Safe to run any number of times.
 */
export async function runAutopayRenewals(
  db: Database,
  gateway: PaymentGateway,
  now: Date = new Date(),
): Promise<Totals> {
  const orgs = await withSystem(db, (tx) =>
    tx
      .select({ id: organisations.id, timezone: organisations.timezone })
      .from(organisations)
      .where(isNull(organisations.deletedAt)),
  );
  const totals: Totals = { renewed: 0, skipped: 0, charged: 0, failed: 0, errors: [] };
  for (const org of orgs) {
    const today = todayIn(org.timezone, now);
    await withTenant(db, org.id, async (tx) => {
      const mandates = await tx
        .select()
        .from(autopayMandates)
        .where(eq(autopayMandates.status, "active"));
      for (const mandate of mandates) {
        const [member] = await tx
          .select()
          .from(members)
          .where(and(eq(members.id, mandate.memberId), isNull(members.deletedAt)));
        if (!member) continue;
        await renew(tx, org.id, mandate, member, today, totals);
        await charge(tx, org.id, mandate, member, gateway, now, totals);
      }
    });
  }
  return totals;
}

async function renew(
  tx: Tx,
  tenantId: string,
  mandate: Mandate,
  member: Member,
  today: string,
  totals: Totals,
) {
  const [latest] = await tx
    .select()
    .from(memberships)
    .where(
      and(eq(memberships.memberId, member.id), inArray(memberships.status, [...LIVE_STATUSES])),
    )
    .orderBy(desc(memberships.endDate))
    .limit(1);
  if (
    !latest ||
    latest.status !== "active" ||
    latest.isTrial ||
    daysBetween(today, latest.endDate) > RENEW_DAYS_BEFORE
  )
    return;
  try {
    // Savepoint: a plan that is no longer sold must not undo the other members' renewals.
    await tx.transaction((sp) =>
      sellPlan(
        sp,
        { tenantId, staffId: null },
        member,
        latest.planId,
        addDays(latest.endDate, 1),
        today,
        mandate.id,
      ),
    );
    totals.renewed += 1;
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    totals.skipped += 1;
  }
}

async function charge(
  tx: Tx,
  tenantId: string,
  mandate: Mandate,
  member: Member,
  gateway: PaymentGateway,
  now: Date,
  totals: Totals,
) {
  const tokenId = mandate.gatewayTokenId;
  if (!tokenId) return;
  const unpaid = await tx
    .select({ invoice: invoices })
    .from(invoices)
    .innerJoin(memberships, eq(memberships.id, invoices.membershipId))
    .where(
      and(
        eq(memberships.renewedByMandateId, mandate.id),
        eq(invoices.kind, "invoice"),
        inArray(invoices.status, ["issued", "partially_paid"]),
      ),
    );
  for (const { invoice } of unpaid) {
    const due = invoice.totalPaise - invoice.paidPaise;
    if (due > mandate.maxAmountPaise) continue; // above what the member approved: reminders only
    const tries = await tx
      .select({ status: payments.status, createdAt: payments.createdAt })
      .from(payments)
      .where(and(eq(payments.invoiceId, invoice.id), eq(payments.method, "autopay")))
      .orderBy(desc(payments.createdAt));
    // A charge still waiting for its webhook is never repeated, so the member is not charged twice.
    if (
      tries.length >= MAX_CHARGE_ATTEMPTS ||
      tries.some((t) => t.status === "pending") ||
      (tries[0] && now.getTime() - tries[0].createdAt.getTime() < RETRY_AFTER_MS)
    )
      continue;

    await lockPayableInvoice(tx, invoice.id, due);
    const [pending] = await tx
      .insert(payments)
      .values({
        tenantId,
        memberId: member.id,
        invoiceId: invoice.id,
        method: "autopay",
        status: "pending",
        amountPaise: due,
        gateway: gateway.name,
        createdAt: now,
      })
      .returning();
    if (!pending) throw new Error("payment insert returned nothing");
    try {
      const { orderId } = await gateway.chargeMandate({
        customerId: mandate.gatewayCustomerId,
        tokenId,
        amountPaise: due,
        receipt: invoice.number,
        notes: { tenantId, paymentId: pending.id },
        payer: { name: member.name, phone: member.phone, email: member.email },
      });
      await tx.update(payments).set({ gatewayOrderId: orderId }).where(eq(payments.id, pending.id));
      totals.charged += 1;
    } catch (error) {
      // The gateway refused or did not answer: count it as a failed try.
      await tx.update(payments).set({ status: "failed" }).where(eq(payments.id, pending.id));
      await appendEvent(
        tx,
        paymentFailed,
        { paymentId: pending.id, memberId: member.id, amountPaise: due, method: "autopay" },
        tenantId,
      );
      totals.failed += 1;
      totals.errors.push(
        `${invoice.number}: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }
}
