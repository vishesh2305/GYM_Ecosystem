import type { routes } from "@gym/contracts";
import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import type { z } from "zod";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import { RequireIdempotencyKey } from "../platform/idempotency";
import { CurrentTenant, Roles, TenantScoped, type TenantContext } from "../tenancy/tenant.guard";
import { PaymentsService, type PaymentOut } from "./payments.service";

@TenantScoped()
@Roles("owner", "manager", "front_desk")
@Controller("orgs/:orgId/invoices/:invoiceId/payments")
export class PaymentsController {
  constructor(@Inject(PaymentsService) private readonly payments: PaymentsService) {}

  @Post()
  @RequireIdempotencyKey()
  record(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.recordPayment.params)) params: { invoiceId: string },
    @Body(new ZodPipe(contracts.recordPayment.body))
    body: z.output<typeof routes.recordPayment.body>,
  ): Promise<PaymentOut> {
    return this.payments.recordAtDesk(tenant, params.invoiceId, body);
  }

  @Get()
  list(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.listInvoicePayments.params)) params: { invoiceId: string },
  ): Promise<PaymentOut[]> {
    return this.payments.list(tenant, params.invoiceId);
  }
}
