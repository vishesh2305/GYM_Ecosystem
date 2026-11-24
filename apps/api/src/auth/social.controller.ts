import type { routes } from "@gym/contracts";
import { Body, Controller, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import { RouteConfig } from "@nestjs/platform-fastify";
import type { FastifyRequest } from "fastify";
import type { z } from "zod";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import { Public } from "./auth.guard";
import { SessionService } from "./session.service";
import { SocialSignInService, type Provider } from "./social.service";

type Route = typeof routes.signInWithProvider;

@Public()
@Controller("auth/social")
export class SocialController {
  constructor(
    @Inject(SocialSignInService) private readonly social: SocialSignInService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  @Post(":provider")
  @HttpCode(200)
  @RouteConfig({ rateLimit: { max: 20, timeWindow: "1 minute" } })
  async signIn(
    @Param(new ZodPipe(contracts.signInWithProvider.params)) params: { provider: Provider },
    @Body(new ZodPipe(contracts.signInWithProvider.body)) body: z.output<Route["body"]>,
    @Req() req: FastifyRequest,
  ): Promise<z.output<Route["response"]>> {
    const { userId, isNewUser } = await this.social.signIn(params.provider, body, req.ip);
    const { sessionId: _, ...pair } = await this.sessions.createSession(userId, {
      amr: [params.provider],
      deviceName: body.deviceName,
      userAgent: req.headers["user-agent"],
      ip: req.ip,
    });
    return { ...pair, isNewUser };
  }
}
