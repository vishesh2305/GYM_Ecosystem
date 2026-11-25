import type { DbHandle } from "@gym/db";
import { and, eq, gt, isNull, sql } from "@gym/db/orm";
import { staffMembers, supportGrants, type StaffRole } from "@gym/db/schema";
import { withTenant, withUser } from "@gym/db";
import {
  applyDecorators,
  createParamDecorator,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  SetMetadata,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";
import { validate } from "uuid";
import type { ApiEnv } from "../env";
import { isPlatformAdmin } from "../admin/admin.guard";
import { recordAudit } from "../platform/audit";
import { DB, ENV } from "../tokens";

/** The organisation a request acts in, and the caller's job there. Set by TenantGuard. */
export interface TenantContext {
  tenantId: string;
  staffId: string;
  role: StaffRole;
  /** Empty = all branches. */
  branchIds: string[];
  /** A platform admin looking in under the owner's support grant: read only, every request audited. */
  support?: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    tenant?: TenantContext;
  }
}

const ROLES = "tenancy:roles";
/** Roles that can see member data or money, and so must use two-step verification. */
const MFA_ROLES: ReadonlySet<StaffRole> = new Set(["owner", "manager", "front_desk"]);

/** Restrict a tenant route to these roles. Without it, any active staff member may call it. */
export const Roles = (...roles: StaffRole[]) => SetMetadata(ROLES, roles);

export const CurrentTenant = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): TenantContext =>
    ctx.switchToHttp().getRequest<FastifyRequest>().tenant as TenantContext,
);

/**
 * Routes under /v1/orgs/:orgId. The organisation comes from the path but is only accepted if the
 * signed-in person actively works there; otherwise it does not exist for them (404, never 403, so the
 * existence of other gyms is not revealed). Then the role is checked (403).
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest<{ Params: { orgId?: string } }>>();
    const orgId = request.params.orgId;
    const userId = request.auth?.userId;
    const notFound = new NotFoundException("Organisation not found");
    if (!userId || !orgId || !validate(orgId)) throw notFound;

    const [membership] = await withUser(this.db.db, userId, (tx) =>
      tx
        .select()
        .from(staffMembers)
        .where(and(eq(staffMembers.tenantId, orgId), eq(staffMembers.status, "active"))),
    );
    if (!membership) {
      if (await this.supportAccess(orgId, userId, request)) return true;
      throw notFound;
    }

    if (
      this.env.STAFF_MFA_REQUIRED &&
      MFA_ROLES.has(membership.role) &&
      !request.auth?.amr.includes("mfa")
    ) {
      throw new ForbiddenException(
        "Two-step verification is required for staff accounts. Turn it on in your account security settings.",
      );
    }

    const allowed = this.reflector.getAllAndOverride<StaffRole[] | undefined>(ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowed && !allowed.includes(membership.role)) {
      throw new ForbiddenException("Your role in this organisation cannot do this");
    }
    request.tenant = {
      tenantId: orgId,
      staffId: membership.id,
      role: membership.role,
      branchIds: membership.branchIds,
    };
    return true;
  }

  /**
   * A platform admin with two-step verification may read (only read) a gym whose owner granted support access
   * that is still valid. Each request is written to the gym's audit log. Without a grant: 404 as for anyone.
   */
  private async supportAccess(
    orgId: string,
    userId: string,
    request: FastifyRequest,
  ): Promise<boolean> {
    if (!(await isPlatformAdmin(this.db.db, userId))) return false;
    const now = new Date();
    const [grant] = await withTenant(this.db.db, orgId, (tx) =>
      tx
        .select({ id: supportGrants.id })
        .from(supportGrants)
        .where(and(gt(supportGrants.expiresAt, now), isNull(supportGrants.revokedAt))),
    );
    if (!grant) return false;
    if (this.env.STAFF_MFA_REQUIRED && !request.auth?.amr.includes("mfa"))
      throw new ForbiddenException("Two-step verification is required for platform admins");
    if (request.method !== "GET") throw new ForbiddenException("Support access is read only");
    await withTenant(this.db.db, orgId, async (tx) => {
      await tx
        .update(supportGrants)
        .set({ views: sql`${supportGrants.views} + 1`, lastViewedAt: now })
        .where(eq(supportGrants.id, grant.id));
      await recordAudit(tx, {
        tenantId: orgId,
        actorType: "admin",
        actorId: userId,
        action: "support.viewed",
        entityType: "support_grant",
        entityId: grant.id,
        data: { method: request.method, path: request.url.split("?")[0] },
        requestId: request.id,
        ip: request.ip,
      });
    });
    request.tenant = {
      tenantId: orgId,
      staffId: userId,
      role: "owner",
      branchIds: [],
      support: true,
    };
    return true;
  }
}

/** Staff with no branch list work at every branch. */
export const isBranchScoped = (tenant: TenantContext) => tenant.branchIds.length > 0;

/** May the caller act at this branch? Other branches should look like they do not exist (404). */
export const canUseBranch = (tenant: TenantContext, branchId: string) =>
  !isBranchScoped(tenant) || tenant.branchIds.includes(branchId);

/** Mark a controller as acting inside the organisation in its `:orgId` path parameter. */
export const TenantScoped = () => applyDecorators(UseGuards(TenantGuard));
