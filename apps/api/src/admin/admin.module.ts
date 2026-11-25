import { Module } from "@nestjs/common";
import { AdminController } from "./admin.controller";
import { PlatformAdminGuard } from "./admin.guard";

/** The platform admin console (A16): gym onboarding (KYC) and feature flags. */
@Module({
  controllers: [AdminController],
  providers: [PlatformAdminGuard],
})
export class AdminModule {}
