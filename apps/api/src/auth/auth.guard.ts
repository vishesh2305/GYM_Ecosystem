import {
  createParamDecorator,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";
import type { AuthContext } from "./auth.types";
import { SessionService } from "./session.service";
import { TokenService } from "./token.service";

const PUBLIC = "auth:public";
const MFA = "auth:mfa";

/** Opt a controller or route out of authentication. Everything else requires a valid access token. */
export const Public = () => SetMetadata(PUBLIC, true);

/** Require a session that completed two-step verification (403 otherwise). */
export const RequireMfa = () => SetMetadata(MFA, true);

/** The signed-in caller (only on routes that are not @Public). */
export const CurrentAuth = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthContext =>
    ctx.switchToHttp().getRequest<FastifyRequest>().auth as AuthContext,
);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const [scheme, token] = (request.headers.authorization ?? "").split(" ");
    const bearer = scheme === "Bearer" && token ? token : undefined;
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) {
      // Public routes still recognise a signed-in caller; a bad token is simply ignored here.
      const auth = bearer ? await this.authenticate(bearer).catch(() => undefined) : undefined;
      if (auth) request.auth = auth;
      return true;
    }

    if (!bearer) throw new UnauthorizedException("Sign in required");
    const auth = await this.authenticate(bearer);
    request.auth = auth;
    if (this.reflector.getAllAndOverride<boolean>(MFA, targets) && !auth.amr.includes("mfa")) {
      throw new ForbiddenException("Two-step verification is required for this action");
    }
    return true;
  }

  private async authenticate(token: string): Promise<AuthContext> {
    const auth = await this.tokens.verifyAccess(token);
    if (await this.sessions.isRevoked(auth.sessionId))
      throw new UnauthorizedException("This session has ended");
    return auth;
  }
}
