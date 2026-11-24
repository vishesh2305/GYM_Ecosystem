import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthController } from "./auth.controller";
import { AuthGuard } from "./auth.guard";
import { MeController } from "./me.controller";
import { OtpController } from "./otp.controller";
import { OtpService } from "./otp.service";
import { ConsoleSmsSender } from "./senders";
import type { ApiEnv } from "../env";
import { ENV, SMS_SENDER } from "../tokens";
import { SessionService } from "./session.service";
import { TokenService } from "./token.service";

@Module({
  controllers: [AuthController, MeController, OtpController],
  providers: [
    TokenService,
    SessionService,
    OtpService,
    { provide: APP_GUARD, useClass: AuthGuard },
    {
      provide: SMS_SENDER,
      inject: [ENV],
      // Real SMS providers (DLT-registered) are added in step A14; env validation blocks "console" in production.
      useFactory: (env: ApiEnv) => {
        switch (env.SMS_PROVIDER) {
          case "console":
            return new ConsoleSmsSender();
        }
      },
    },
  ],
  exports: [TokenService, SessionService],
})
export class AuthModule {}
