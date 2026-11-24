import { Module } from "@nestjs/common";
import { MembershipModule } from "../membership/membership.module";
import { InvoicesController } from "./invoices.controller";

@Module({ imports: [MembershipModule], controllers: [InvoicesController] })
export class BillingModule {}
