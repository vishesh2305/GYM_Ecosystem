import { Module } from "@nestjs/common";
import { MembersController } from "./members.controller";
import { MembersService } from "./members.service";
import { PlansController } from "./plans.controller";

@Module({
  controllers: [PlansController, MembersController],
  providers: [MembersService],
  exports: [MembersService],
})
export class MembershipModule {}
