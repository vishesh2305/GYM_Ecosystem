import { withUser, type DbHandle } from "@gym/db";
import { platformAdmins } from "@gym/db/schema";
import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { ApiEnv } from "../env";
import { DB, ENV } from "../tokens";

/** Whether this person runs the platform (RLS lets them see only their own platform_admins row). */
export async function isPlatformAdmin(db: DbHandle["db"], userId: string): Promise<boolean> {
  const rows = await withUser(db, userId, (tx) =>
    tx.select({ userId: platformAdmins.userId }).from(platformAdmins),
  );
  return rows.length > 0;
}

/** Routes under /v1/admin: platform admins only, with two-step verification. */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const auth = context.switchToHttp().getRequest<FastifyRequest>().auth;
    if (!auth) throw new UnauthorizedException("Sign in required");
    if (!(await isPlatformAdmin(this.db.db, auth.userId)))
      throw new ForbiddenException("Only platform admins can do this");
    if (this.env.STAFF_MFA_REQUIRED && !auth.amr.includes("mfa"))
      throw new ForbiddenException("Two-step verification is required for platform admins");
    return true;
  }
}
