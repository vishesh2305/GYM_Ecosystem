import { Controller, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { Public } from "../auth/auth.guard";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import { CurrentTenant, Roles, TenantScoped, type TenantContext } from "../tenancy/tenant.guard";
import { OnlinePaymentsService } from "./online-payments.service";

@TenantScoped()
@Roles("owner", "manager", "front_desk")
@Controller("orgs/:orgId/invoices/:invoiceId/pay-online")
export class StartOnlinePaymentController {
  constructor(@Inject(OnlinePaymentsService) private readonly online: OnlinePaymentsService) {}

  @Post()
  @HttpCode(201)
  start(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.startOnlinePayment.params)) params: { invoiceId: string },
  ) {
    return this.online.start(tenant, params.invoiceId);
  }
}

@Public()
@Controller("webhooks/razorpay")
export class RazorpayWebhookController {
  constructor(@Inject(OnlinePaymentsService) private readonly online: OnlinePaymentsService) {}

  @Post()
  @HttpCode(200)
  async receive(@Req() req: RawBodyRequest<FastifyRequest>): Promise<{ received: true }> {
    const signature = req.headers["x-razorpay-signature"];
    await this.online.handleWebhook(
      req.rawBody,
      typeof signature === "string" ? signature : undefined,
      req.body,
    );
    return { received: true };
  }
}
