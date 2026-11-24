import { Module } from "@nestjs/common";
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
  ],
  providers: [MembersService, MembershipsService],
  exports: [MembersService, MembershipsService],
})
export class MembershipModule {}
