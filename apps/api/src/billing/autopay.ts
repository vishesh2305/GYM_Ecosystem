import { withTenant, type DbHandle, type Tx } from "@gym/db";
import { and, desc, eq, inArray } from "@gym/db/orm";
import { autopayMandates, payments } from "@gym/db/schema";
import {
  BadRequestException,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import { v7 } from "uuid";
import type { z } from "zod";
import type { routes } from "@gym/contracts";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import { MembersService } from "../membership/members.service";
import { recordAudit } from "../platform/audit";
import { CurrentTenant, Roles, TenantScoped, type TenantContext } from "../tenancy/tenant.guard";
import { DB, PAYMENT_GATEWAY } from "../tokens";
import type { PaymentGateway } from "./gateway";
import { lockPayableInvoice, PaymentsService } from "./payments.service";

type Mandate = typeof autopayMandates.$inferSelect;
export type MandateOut = z.output<typeof routes.getAutopay.response>;

const LIVE = ["pending", "active"] as const;

const toMandate = (m: Mandate): MandateOut => ({
  id: m.id,
  memberId: m.memberId,
  status: m.status,
  maxAmountPaise: m.maxAmountPaise,
  confirmedAt: m.confirmedAt?.toISOString() ?? null,
  cancelledAt: m.cancelledAt?.toISOString() ?? null,
  createdAt: m.createdAt.toISOString(),
});

/**
 * Called from the payment webhook for the mandate's first payment: captured with a token means the member
 * approved AutoPay; anything else means they did not. Only a pending mandate for this very order changes.
 */
export async function settleMandate(
  tx: Tx,
  mandateId: string,
  orderId: string,
  tokenId: string | null,
): Promise<void> {
  await tx
    .update(autopayMandates)
    .set(
      tokenId
        ? { status: "active", gatewayTokenId: tokenId, confirmedAt: new Date() }
        : { status: "failed" },
    )
    .where(
      and(
        eq(autopayMandates.id, mandateId),
        eq(autopayMandates.status, "pending"),
        eq(autopayMandates.gatewayOrderId, orderId),
      ),
    );
}

@Injectable()
export class AutopayService {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(MembersService) private readonly members: MembersService,
  ) {}

  /**
   * Take what is due on the invoice and ask the member to approve UPI AutoPay in the same checkout. The
   * approved limit per charge is the invoice total; a renewal that costs more falls back to reminders.
   * A mandate the member never approved is replaced.
   */
  async start(tenant: TenantContext, invoiceId: string) {
    const invoice = await this.payments.visibleInvoice(tenant, invoiceId);
    const due = invoice.totalPaise - invoice.paidPaise;
    if (due <= 0 || invoice.kind !== "invoice")
      throw new BadRequestException("Nothing is due on this invoice");
    const member = await this.members.find(tenant, invoice.memberId);

    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      await lockPayableInvoice(tx, invoiceId, due);
      const [live] = await this.liveMandate(tx, member.id, true);
      if (live?.status === "active")
        throw new ConflictException("This member already has AutoPay; turn it off first");
      if (live)
        await tx
          .update(autopayMandates)
          .set({ status: "cancelled", cancelledAt: new Date() })
          .where(eq(autopayMandates.id, live.id));

      const [pending] = await tx
        .insert(payments)
        .values({
          tenantId: tenant.tenantId,
          memberId: member.id,
          invoiceId,
          method: "autopay",
          status: "pending",
          amountPaise: due,
          gateway: this.gateway.name,
        })
        .returning();
      if (!pending) throw new Error("payment insert returned nothing");
      const mandateId = v7();
      const maxAmountPaise = invoice.totalPaise;
      const notes = { tenantId: tenant.tenantId, paymentId: pending.id, mandateId };
      const { orderId, customerId } = await this.gateway.createMandateOrder({
        amountPaise: due,
        maxAmountPaise,
        receipt: invoice.number,
        notes,
        payer: { name: member.name, phone: member.phone, email: member.email },
      });
      await tx.update(payments).set({ gatewayOrderId: orderId }).where(eq(payments.id, pending.id));
      await tx.insert(autopayMandates).values({
        id: mandateId,
        tenantId: tenant.tenantId,
        memberId: member.id,
        status: "pending",
        maxAmountPaise,
        gateway: this.gateway.name,
        gatewayCustomerId: customerId,
        gatewayOrderId: orderId,
        createdBy: tenant.staffId,
      });
      await recordAudit(tx, {
        tenantId: tenant.tenantId,
        actorType: "staff",
        actorId: tenant.staffId,
        action: "autopay.requested",
        entityType: "member",
        entityId: member.id,
        data: { mandateId, maxAmountPaise },
      });
      return {
        paymentId: pending.id,
        gateway: this.gateway.name,
        keyId: this.gateway.keyId,
        orderId,
        amountPaise: due,
        currency: "INR" as const,
        notes,
        mandateId,
        customerId,
        maxAmountPaise,
        recurring: true as const,
      };
    });
  }

  async current(tenant: TenantContext, memberId: string): Promise<MandateOut> {
    await this.members.find(tenant, memberId);
    const [live] = await withTenant(this.db.db, tenant.tenantId, (tx) =>
      this.liveMandate(tx, memberId, false),
    );
    if (!live) throw new NotFoundException("This member has no AutoPay");
    return toMandate(live);
  }

  /** Stop future charges. An approved mandate is revoked at the gateway first, so a failure there changes nothing. */
  async cancel(tenant: TenantContext, memberId: string): Promise<void> {
    await this.members.find(tenant, memberId);
    await withTenant(this.db.db, tenant.tenantId, async (tx) => {
      const [live] = await this.liveMandate(tx, memberId, true);
      if (!live) throw new NotFoundException("This member has no AutoPay");
      if (live.gatewayTokenId)
        await this.gateway.cancelMandate(live.gatewayCustomerId, live.gatewayTokenId);
      await tx
        .update(autopayMandates)
        .set({ status: "cancelled", cancelledAt: new Date() })
        .where(eq(autopayMandates.id, live.id));
      await recordAudit(tx, {
        tenantId: tenant.tenantId,
        actorType: "staff",
        actorId: tenant.staffId,
        action: "autopay.cancelled",
        entityType: "member",
        entityId: memberId,
        data: { mandateId: live.id },
      });
    });
  }

  private liveMandate(tx: Tx, memberId: string, lock: boolean) {
    const query = tx
      .select()
      .from(autopayMandates)
      .where(
        and(eq(autopayMandates.memberId, memberId), inArray(autopayMandates.status, [...LIVE])),
      )
      .orderBy(desc(autopayMandates.createdAt))
      .limit(1);
    return lock ? query.for("update") : query;
  }
}

@TenantScoped()
@Roles("owner", "manager", "front_desk")
@Controller("orgs/:orgId")
export class AutopayController {
  constructor(@Inject(AutopayService) private readonly autopay: AutopayService) {}

  @Post("invoices/:invoiceId/pay-autopay")
  @HttpCode(201)
  start(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.startAutopay.params)) params: { invoiceId: string },
  ) {
    return this.autopay.start(tenant, params.invoiceId);
  }

  @Get("members/:memberId/autopay")
  current(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.getAutopay.params)) params: { memberId: string },
  ) {
    return this.autopay.current(tenant, params.memberId);
  }

  @Delete("members/:memberId/autopay")
  @HttpCode(204)
  async cancel(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.cancelAutopay.params)) params: { memberId: string },
  ): Promise<void> {
    await this.autopay.cancel(tenant, params.memberId);
  }
}
