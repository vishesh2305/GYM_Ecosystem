import {
  createParamDecorator,
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

/** Opt a controller or route out of authentication. Everything else requires a valid access token. */
export const Public = () => SetMetadata(PUBLIC, true);

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
    if (
      this.reflector.getAllAndOverride<boolean>(PUBLIC, [context.getHandler(), context.getClass()])
    )
      return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const [scheme, token] = (request.headers.authorization ?? "").split(" ");
    if (scheme !== "Bearer" || !token) throw new UnauthorizedException("Sign in required");

    const auth = await this.tokens.verifyAccess(token);
    if (await this.sessions.isRevoked(auth.sessionId))
      throw new UnauthorizedException("This session has ended");
    request.auth = auth;
    return true;
  }
}
