import type { routes } from "@gym/contracts";
import { withTenant, type DbHandle } from "@gym/db";
import { eq } from "@gym/db/orm";
import { invoices, payments, refunds } from "@gym/db/schema";
import { paymentStatus } from "@gym/domain";
import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import type { z } from "zod";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import { MembersService } from "../membership/members.service";
import { recordAudit } from "../platform/audit";
import { RequireIdempotencyKey } from "../platform/idempotency";
import { CurrentTenant, Roles, TenantScoped, type TenantContext } from "../tenancy/tenant.guard";
import { DB, PAYMENT_GATEWAY } from "../tokens";
import type { PaymentGateway } from "./gateway";
import { postJournal } from "./ledger";
import { toPayment } from "./payments.service";

type RefundOut = z.output<typeof routes.refundPayment.response>;
const moneyAccount = (method: string) =>
  method === "cash"
    ? "cash"
    : method === "online" || method === "autopay"
      ? "gateway_clearing"
      : "bank";

@Injectable()
export class RefundsService {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(MembersService) private readonly members: MembersService,
  ) {}

  /**
   * Refund part or all of a captured payment. The payment row is locked, so two refunds cannot together exceed
   * it. Online money goes back through the gateway first; if that fails, nothing is recorded.
   */
  async refund(
    tenant: TenantContext,
    paymentId: string,
    input: { amountPaise: number; reason: string },
  ): Promise<RefundOut> {
    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      const [payment] = await tx
        .select()
        .from(payments)
        .where(eq(payments.id, paymentId))
        .for("update");
      if (!payment) throw new NotFoundException("Payment not found");
      await this.members.find(tenant, payment.memberId);
      if (payment.status !== "captured")
        throw new BadRequestException("Only received payments can be refunded");
      const left = payment.amountPaise - payment.refundedPaise;
      if (input.amountPaise > left)
        throw new BadRequestException(`At most ${left} paise can still be refunded`);

      const online = payment.method === "online" || payment.method === "autopay";
      const gatewayRefundId =
        online && payment.gatewayPaymentId
          ? (await this.gateway.refund(payment.gatewayPaymentId, input.amountPaise)).refundId
          : null;

      const [refund] = await tx
        .insert(refunds)
        .values({
          tenantId: tenant.tenantId,
          paymentId,
          amountPaise: input.amountPaise,
          reason: input.reason,
          gatewayRefundId,
          createdBy: tenant.staffId,
        })
        .returning();
      const [updatedPayment] = await tx
        .update(payments)
        .set({ refundedPaise: payment.refundedPaise + input.amountPaise })
        .where(eq(payments.id, paymentId))
        .returning();
      const [invoice] = await tx
        .select()
        .from(invoices)
        .where(eq(invoices.id, payment.invoiceId))
        .for("update");
      if (!refund || !updatedPayment || !invoice) throw new Error("refund bookkeeping failed");
      const paidPaise = invoice.paidPaise - input.amountPaise;
      await tx
        .update(invoices)
        .set({ paidPaise, status: paymentStatus(invoice.totalPaise, paidPaise) })
        .where(eq(invoices.id, invoice.id));

      await postJournal(tx, {
        tenantId: tenant.tenantId,
        sourceType: "refund",
        sourceId: refund.id,
        memo: `refund for ${invoice.number}`,
        lines: [
          { account: "receivable", debitPaise: input.amountPaise, memberId: payment.memberId },
          { account: moneyAccount(payment.method), creditPaise: input.amountPaise },
        ],
      });
      await recordAudit(tx, {
        tenantId: tenant.tenantId,
        actorType: "staff",
        actorId: tenant.staffId,
        action: "payment.refunded",
        entityType: "payment",
        entityId: paymentId,
        data: { amountPaise: input.amountPaise, reason: input.reason },
      });
      return {
        id: refund.id,
        paymentId,
        amountPaise: refund.amountPaise,
        gatewayRefundId,
        payment: toPayment(updatedPayment),
      };
    });
  }
}

@TenantScoped()
@Roles("owner", "manager")
@Controller("orgs/:orgId/payments/:paymentId/refunds")
export class RefundsController {
  constructor(@Inject(RefundsService) private readonly refunds: RefundsService) {}

  @Post()
  @RequireIdempotencyKey()
  refund(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.refundPayment.params)) params: { paymentId: string },
    @Body(new ZodPipe(contracts.refundPayment.body))
    body: z.output<typeof routes.refundPayment.body>,
  ): Promise<RefundOut> {
    return this.refunds.refund(tenant, params.paymentId, body);
  }
}
