import type { routes } from "@gym/contracts";
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import type { z } from "zod";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import { CurrentAuth, Public } from "./auth.guard";
import type { AuthContext } from "./auth.types";
import { SessionService } from "./session.service";

type Out<K extends keyof typeof routes> = z.output<(typeof routes)[K]["response"]>;

@Controller("auth")
export class AuthController {
  constructor(@Inject(SessionService) private readonly sessions: SessionService) {}

  @Public()
  @Post("refresh")
  @HttpCode(200)
  async refresh(
    @Body(new ZodPipe(contracts.refreshSession.body)) body: { refreshToken: string },
  ): Promise<Out<"refreshSession">> {
    const { sessionId: _, ...pair } = await this.sessions.refresh(body.refreshToken);
    return pair;
  }

  @Post("logout")
  @HttpCode(204)
  async logout(@CurrentAuth() auth: AuthContext): Promise<void> {
    await this.sessions.revoke(auth.sessionId, "signed_out");
  }

  @Post("logout-all")
  @HttpCode(204)
  async logoutAll(@CurrentAuth() auth: AuthContext): Promise<void> {
    await this.sessions.revokeAll(auth.userId, "signed_out_everywhere");
  }

  @Get("sessions")
  async list(@CurrentAuth() auth: AuthContext): Promise<Out<"listSessions">> {
    return (await this.sessions.active(auth.userId)).map((s) => ({
      id: s.id,
      deviceName: s.deviceName,
      userAgent: s.userAgent,
      ip: s.ip,
      createdAt: s.createdAt.toISOString(),
      lastUsedAt: s.lastUsedAt.toISOString(),
      current: s.id === auth.sessionId,
    }));
  }

  @Delete("sessions/:sessionId")
  @HttpCode(204)
  async revoke(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodPipe(contracts.revokeSession.params)) params: { sessionId: string },
  ): Promise<void> {
    await this.sessions.revokeOwn(auth.userId, params.sessionId);
  }
}
