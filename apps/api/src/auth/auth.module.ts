import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthController } from "./auth.controller";
import { AuthGuard } from "./auth.guard";
import { MeController } from "./me.controller";
import { SessionService } from "./session.service";
import { TokenService } from "./token.service";

@Module({
  controllers: [AuthController, MeController],
  providers: [TokenService, SessionService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [TokenService, SessionService],
})
export class AuthModule {}
