import { Module } from "@nestjs/common";
import { MyPrivacyController } from "./privacy.controller";

/** Personal data rights (A16): export and erasure requests, run by the worker's privacy job. */
@Module({
  controllers: [MyPrivacyController],
})
export class PrivacyModule {}
