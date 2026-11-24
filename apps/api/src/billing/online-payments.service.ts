import { withTenant, type DbHandle } from "@gym/db";
import { and, eq } from "@gym/db/orm";
import { payments } from "@gym/db/schema";
import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { validate } from "uuid";
import { z } from "zod";
import type { ApiEnv } from "../env";
import { recordAudit } from "../platform/audit";
import type { TenantContext } from "../tenancy/tenant.guard";
import { DB, ENV, PAYMENT_GATEWAY } from "../tokens";
import { verifyWebhookSignature, type PaymentGateway } from "./gateway";
import { applyCapturedPayment, lockPayableInvoice, PaymentsService } from "./payments.service";

const webhookBody = z.object({
  event: z.string(),
  payload: z
    .object({
      payment: z
        .object({
          entity: z.object({
            id: z.string(),
            order_id: z.string().nullable().optional(),
            amount: z.number().int(),
            notes: z.record(z.string(), z.unknown()).optional(),
          }),
        })
        .optional(),
    })
    .optional(),
});

@Injectable()
export class OnlinePaymentsService {
  private readonly logger = new Logger(OnlinePaymentsService.name);

  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
  ) {}

  /** Create a gateway order for what is still due. The order notes carry the tenant and payment ids. */
  async start(tenant: TenantContext, invoiceId: string) {
    const invoice = await this.payments.visibleInvoice(tenant, invoiceId);
    const due = invoice.totalPaise - invoice.paidPaise;
    if (due <= 0 || invoice.kind !== "invoice")
      throw new BadRequestException("Nothing is due on this invoice");
    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      await lockPayableInvoice(tx, invoiceId, due);
      const [pending] = await tx
        .insert(payments)
        .values({
          tenantId: tenant.tenantId,
          memberId: invoice.memberId,
          invoiceId,
          method: "online",
          status: "pending",
          amountPaise: due,
          gateway: this.gateway.name,
        })
        .returning();
      if (!pending) throw new Error("payment insert returned nothing");
      const notes = { tenantId: tenant.tenantId, paymentId: pending.id };
      const { orderId } = await this.gateway.createOrder({
        amountPaise: due,
        receipt: invoice.number,
        notes,
      });
      await tx.update(payments).set({ gatewayOrderId: orderId }).where(eq(payments.id, pending.id));
      return {
        paymentId: pending.id,
        gateway: this.gateway.name,
        keyId: this.gateway.keyId,
        orderId,
        amountPaise: due,
        currency: "INR" as const,
        notes,
      };
    });
  }

  /**
   * Gateway webhook. Only signed requests are accepted; the tenant comes from the order notes we created, and
   * the order id must match the stored payment. Repeats and out-of-order events are harmless.
   */
  async handleWebhook(
    rawBody: Buffer | undefined,
    signature: string | undefined,
    body: unknown,
  ): Promise<void> {
    if (!rawBody || !verifyWebhookSignature(rawBody, signature, this.env.RAZORPAY_WEBHOOK_SECRET)) {
      throw new BadRequestException("Invalid webhook signature");
    }
    const parsed = webhookBody.safeParse(body);
    const entity = parsed.success ? parsed.data.payload?.payment?.entity : undefined;
    const event = parsed.success ? parsed.data.event : "";
    if (!entity || (event !== "payment.captured" && event !== "payment.failed")) return;
    const tenantId = String(entity.notes?.tenantId ?? "");
    const paymentId = String(entity.notes?.paymentId ?? "");
    if (!validate(tenantId) || !validate(paymentId) || !entity.order_id) return;

    await withTenant(this.db.db, tenantId, async (tx) => {
      const [payment] = await tx
        .select()
        .from(payments)
        .where(and(eq(payments.id, paymentId), eq(payments.gatewayOrderId, entity.order_id ?? "")))
        .for("update");
      if (!payment || payment.status === "captured") return;

      if (event === "payment.failed") {
        await tx
          .update(payments)
          .set({ status: "failed", gatewayPaymentId: entity.id })
          .where(eq(payments.id, payment.id));
        return;
      }
      if (entity.amount !== payment.amountPaise) {
        this.logger.warn(
          `amount mismatch on payment ${payment.id}: expected ${payment.amountPaise}, got ${entity.amount}`,
        );
        return;
      }
      const [captured] = await tx
        .update(payments)
        .set({ status: "captured", gatewayPaymentId: entity.id, capturedAt: new Date() })
        .where(eq(payments.id, payment.id))
        .returning();
      if (!captured) return;
      try {
        await tx.transaction((sp) => applyCapturedPayment(sp, captured));
      } catch (error) {
        // Paid twice (e.g. also at the desk): keep the money on record for a refund instead of failing the webhook.
        if (!(error instanceof BadRequestException)) throw error;
        await recordAudit(tx, {
          tenantId,
          actorType: "system",
          action: "payment.unapplied",
          entityType: "payment",
          entityId: captured.id,
          data: { reason: error.message },
        });
      }
    });
  }
}
