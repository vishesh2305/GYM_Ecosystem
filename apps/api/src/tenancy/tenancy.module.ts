import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { BranchesController } from "./branches.controller";
import { OrganisationController, OrganisationsController } from "./organisations.controller";
import { InvitesController, StaffController } from "./staff.controller";
import { StaffService } from "./staff.service";
import { TenantGuard } from "./tenant.guard";

@Module({
  imports: [AuthModule],
  controllers: [
    OrganisationsController,
    OrganisationController,
    BranchesController,
    StaffController,
    InvitesController,
  ],
  providers: [TenantGuard, StaffService],
})
export class TenancyModule {}
