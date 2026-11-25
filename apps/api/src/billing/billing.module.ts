import { Module } from "@nestjs/common";
import type { ApiEnv } from "../env";
import { MembershipModule } from "../membership/membership.module";
import { ENV, PAYMENT_GATEWAY } from "../tokens";
import { AutopayController, AutopayService } from "./autopay";
import { FakeGateway, RazorpayGateway } from "./gateway";
import { InvoicesController } from "./invoices.controller";
import { OnlinePaymentsService } from "./online-payments.service";
import {
  RazorpayWebhookController,
  StartOnlinePaymentController,
} from "./online-payments.controller";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";
import { RefundsController, RefundsService } from "./refunds";

@Module({
  imports: [MembershipModule],
  controllers: [
    InvoicesController,
    PaymentsController,
    StartOnlinePaymentController,
    RazorpayWebhookController,
    RefundsController,
    AutopayController,
  ],
  providers: [
    PaymentsService,
    OnlinePaymentsService,
    RefundsService,
    AutopayService,
    {
      provide: PAYMENT_GATEWAY,
      inject: [ENV],
      useFactory: (env: ApiEnv) =>
        env.PAYMENT_GATEWAY === "razorpay" && env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET
          ? new RazorpayGateway(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET)
          : new FakeGateway(),
    },
  ],
  exports: [PaymentsService, PAYMENT_GATEWAY],
})
export class BillingModule {}
