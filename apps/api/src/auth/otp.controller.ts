import type { routes } from "@gym/contracts";
import { Body, Controller, HttpCode, Inject, Post, Req } from "@nestjs/common";
import { RouteConfig } from "@nestjs/platform-fastify";
import type { FastifyRequest } from "fastify";
import type { z } from "zod";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import { Public } from "./auth.guard";
import { OtpService } from "./otp.service";
import { SessionService } from "./session.service";

type In<K extends keyof typeof routes> = (typeof routes)[K] extends {
  body: infer B extends z.ZodType;
}
  ? z.output<B>
  : never;
type Out<K extends keyof typeof routes> = z.output<(typeof routes)[K]["response"]>;

@Public()
@Controller("auth/otp")
export class OtpController {
  constructor(
    @Inject(OtpService) private readonly otp: OtpService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  @Post("request")
  @HttpCode(202)
  @RouteConfig({ rateLimit: { max: 10, timeWindow: "1 minute" } })
  request(
    @Body(new ZodPipe(contracts.requestOtp.body)) body: In<"requestOtp">,
    @Req() req: FastifyRequest,
  ): Promise<Out<"requestOtp">> {
    return this.otp.request(body, req.ip);
  }

  @Post("verify")
  @HttpCode(200)
  @RouteConfig({ rateLimit: { max: 20, timeWindow: "1 minute" } })
  async verify(
    @Body(new ZodPipe(contracts.verifyOtp.body)) body: In<"verifyOtp">,
    @Req() req: FastifyRequest,
  ): Promise<Out<"verifyOtp">> {
    const { userId, isNewUser } = await this.otp.verify(body.challengeId, body.code, req.ip);
    const { sessionId: _, ...pair } = await this.sessions.createSession(userId, {
      amr: ["otp"],
      deviceName: body.deviceName,
      userAgent: req.headers["user-agent"],
      ip: req.ip,
    });
    return { ...pair, isNewUser };
  }
}
