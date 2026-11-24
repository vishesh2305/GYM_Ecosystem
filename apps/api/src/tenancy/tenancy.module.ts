import { Module } from "@nestjs/common";
import { BranchesController } from "./branches.controller";
import { OrganisationController, OrganisationsController } from "./organisations.controller";
import { TenantGuard } from "./tenant.guard";

@Module({
  controllers: [OrganisationsController, OrganisationController, BranchesController],
  providers: [TenantGuard],
})
export class TenancyModule {}
