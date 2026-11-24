import type { routes } from "@gym/contracts";
import { withTenant, type DbHandle, type Tx } from "@gym/db";
import { asc, eq } from "@gym/db/orm";
import { invoices, payments } from "@gym/db/schema";
import { paymentStatus } from "@gym/domain";
import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { z } from "zod";
import { MembersService } from "../membership/members.service";
import { recordAudit } from "../platform/audit";
import { appendEvent, defineEvent } from "../platform/events";
import type { TenantContext } from "../tenancy/tenant.guard";
import { DB } from "../tokens";
import { postJournal } from "./ledger";

export type PaymentOut = z.output<typeof routes.recordPayment.response>;
type Method = (typeof payments.$inferSelect)["method"];

export const paymentReceived = defineEvent(
  "payment.received",
  z.object({
    paymentId: z.uuid(),
    invoiceId: z.uuid(),
    memberId: z.uuid(),
    amountPaise: z.number().int(),
    method: z.string(),
  }),
);

export const toPayment = (p: typeof payments.$inferSelect): PaymentOut => ({
  id: p.id,
  invoiceId: p.invoiceId,
  method: p.method,
  status: p.status,
  amountPaise: p.amountPaise,
  refundedPaise: p.refundedPaise,
  reference: p.reference,
  capturedAt: p.capturedAt?.toISOString() ?? null,
  createdAt: p.createdAt.toISOString(),
});

/** Desk and gateway money both land here: cash in the till, everything else in the bank. */
const cashAccount = (method: Method) =>
  method === "cash"
    ? "cash"
    : method === "online" || method === "autopay"
      ? "gateway_clearing"
      : "bank";

/** Lock the invoice and check `amount` fits in what is still due. */
export async function lockPayableInvoice(tx: Tx, invoiceId: string, amountPaise: number) {
  const [invoice] = await tx
    .select()
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .for("update");
  if (!invoice) throw new NotFoundException("Invoice not found");
  if (invoice.kind !== "invoice" || invoice.status === "void")
    throw new BadRequestException("This document cannot be paid");
  const due = invoice.totalPaise - invoice.paidPaise;
  if (amountPaise > due)
    throw new BadRequestException(`That is more than what is due (${due} paise)`);
  return invoice;
}

/**
 * Apply a captured payment to its (locked) invoice: update the paid amount and status, post
 * Dr cash/bank/clearing, Cr receivable, and publish payment.received.
 */
export async function applyCapturedPayment(
  tx: Tx,
  payment: typeof payments.$inferSelect,
): Promise<void> {
  const invoice = await lockPayableInvoice(tx, payment.invoiceId, payment.amountPaise);
  const paidPaise = invoice.paidPaise + payment.amountPaise;
  await tx
    .update(invoices)
    .set({ paidPaise, status: paymentStatus(invoice.totalPaise, paidPaise) })
    .where(eq(invoices.id, invoice.id));
  await postJournal(tx, {
    tenantId: payment.tenantId,
    sourceType: "payment",
    sourceId: payment.id,
    memo: `${payment.method} for ${invoice.number}`,
    lines: [
      { account: cashAccount(payment.method), debitPaise: payment.amountPaise },
      { account: "receivable", creditPaise: payment.amountPaise, memberId: payment.memberId },
    ],
  });
  await appendEvent(
    tx,
    paymentReceived,
    {
      paymentId: payment.id,
      invoiceId: invoice.id,
      memberId: payment.memberId,
      amountPaise: payment.amountPaise,
      method: payment.method,
    },
    payment.tenantId,
  );
}

@Injectable()
export class PaymentsService {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(MembersService) private readonly members: MembersService,
  ) {}

  /** The invoice must belong to a member the caller can see (404 otherwise). */
  async visibleInvoice(tenant: TenantContext, invoiceId: string) {
    const [invoice] = await withTenant(this.db.db, tenant.tenantId, (tx) =>
      tx.select().from(invoices).where(eq(invoices.id, invoiceId)),
    );
    if (!invoice) throw new NotFoundException("Invoice not found");
    await this.members.find(tenant, invoice.memberId);
    return invoice;
  }

  async recordAtDesk(
    tenant: TenantContext,
    invoiceId: string,
    input: z.output<typeof routes.recordPayment.body>,
  ): Promise<PaymentOut> {
    const invoice = await this.visibleInvoice(tenant, invoiceId);
    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      await lockPayableInvoice(tx, invoiceId, input.amountPaise);
      const [payment] = await tx
        .insert(payments)
        .values({
          tenantId: tenant.tenantId,
          memberId: invoice.memberId,
          invoiceId,
          method: input.method,
          status: "captured",
          amountPaise: input.amountPaise,
          reference: input.reference,
          receivedBy: tenant.staffId,
          capturedAt: new Date(),
        })
        .returning();
      if (!payment) throw new Error("payment insert returned nothing");
      await applyCapturedPayment(tx, payment);
      await recordAudit(tx, {
        tenantId: tenant.tenantId,
        actorType: "staff",
        actorId: tenant.staffId,
        action: "payment.recorded",
        entityType: "payment",
        entityId: payment.id,
        data: { invoiceId, method: input.method, amountPaise: input.amountPaise },
      });
      return toPayment(payment);
    });
  }

  async list(tenant: TenantContext, invoiceId: string): Promise<PaymentOut[]> {
    await this.visibleInvoice(tenant, invoiceId);
    const rows = await withTenant(this.db.db, tenant.tenantId, (tx) =>
      tx
        .select()
        .from(payments)
        .where(eq(payments.invoiceId, invoiceId))
        .orderBy(asc(payments.createdAt)),
    );
    return rows.map(toPayment);
  }
}
