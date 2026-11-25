import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { MyPrivacyController } from "./privacy.controller";

/** Personal data rights (A16): export and erasure requests, run by the worker's privacy job. */
@Module({
  imports: [AuthModule],
  controllers: [MyPrivacyController],
})
export class PrivacyModule {}
