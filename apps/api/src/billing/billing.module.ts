import { Module } from "@nestjs/common";
import { MembershipModule } from "../membership/membership.module";
import { InvoicesController } from "./invoices.controller";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";

@Module({
  imports: [MembershipModule],
  controllers: [InvoicesController, PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class BillingModule {}
