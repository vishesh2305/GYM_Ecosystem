import type { routes } from "@gym/contracts";
import { Body, Controller, Delete, Get, HttpCode, Inject, Post } from "@nestjs/common";
import { RouteConfig } from "@nestjs/platform-fastify";
import type { z } from "zod";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import { CurrentAuth, RequireMfa } from "./auth.guard";
import type { AuthContext } from "./auth.types";
import { MfaService } from "./mfa.service";
import { SessionService } from "./session.service";

type Out<K extends keyof typeof routes> = z.output<(typeof routes)[K]["response"]>;

@Controller("auth/mfa")
export class MfaController {
  constructor(
    @Inject(MfaService) private readonly mfa: MfaService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  @Get()
  status(@CurrentAuth() auth: AuthContext): Promise<Out<"getMfaStatus">> {
    return this.mfa.status(auth.userId);
  }

  @Post("totp/setup")
  setup(@CurrentAuth() auth: AuthContext): Promise<Out<"setupTotp">> {
    return this.mfa.setup(auth.userId);
  }

  @Post("totp/confirm")
  @HttpCode(200)
  confirm(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(contracts.confirmTotp.body)) body: { code: string },
  ): Promise<Out<"confirmTotp">> {
    return this.mfa.confirm(auth.userId, body.code);
  }

  @Post("verify")
  @HttpCode(200)
  @RouteConfig({ rateLimit: { max: 10, timeWindow: "1 minute" } })
  async verify(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(contracts.verifyMfa.body)) body: z.output<typeof routes.verifyMfa.body>,
  ): Promise<Out<"verifyMfa">> {
    await this.mfa.verify(auth.userId, body);
    const { sessionId: _, ...pair } = await this.sessions.elevate(auth.sessionId);
    return pair;
  }

  @Delete("totp")
  @HttpCode(204)
  @RequireMfa()
  async disable(@CurrentAuth() auth: AuthContext): Promise<void> {
    await this.mfa.disable(auth.userId);
  }
}
