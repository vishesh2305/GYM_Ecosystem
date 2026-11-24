import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { createTransport } from "nodemailer";
import type { ApiEnv } from "../env";
import { EMAIL_SENDER, ENV, SMS_SENDER } from "../tokens";
import { AuthController } from "./auth.controller";
import { AuthGuard } from "./auth.guard";
import { MeController } from "./me.controller";
import { OtpController } from "./otp.controller";
import { OtpService } from "./otp.service";
import { ConsoleEmailSender, ConsoleSmsSender, SmtpEmailSender } from "./senders";
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
    {
      provide: EMAIL_SENDER,
      inject: [ENV],
      useFactory: (env: ApiEnv) =>
        env.EMAIL_PROVIDER === "smtp" && env.SMTP_URL
          ? new SmtpEmailSender(createTransport(env.SMTP_URL), env.EMAIL_FROM)
          : new ConsoleEmailSender(),
    },
  ],
  exports: [TokenService, SessionService],
})
export class AuthModule {}
