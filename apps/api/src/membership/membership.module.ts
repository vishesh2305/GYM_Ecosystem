import { Module } from "@nestjs/common";
import { MemberImportsController } from "./imports.controller";
import { MembersController } from "./members.controller";
import { MembersService } from "./members.service";
import { MemberMembershipsController, MembershipActionsController } from "./memberships.controller";
import { MembershipsService } from "./memberships.service";
import { PlansController } from "./plans.controller";

@Module({
  controllers: [
    PlansController,
    MembersController,
    MemberMembershipsController,
    MembershipActionsController,
    MemberImportsController,
  ],
  providers: [MembersService, MembershipsService],
  exports: [MembersService, MembershipsService],
})
export class MembershipModule {}
