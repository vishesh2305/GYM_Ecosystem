import type { DbHandle } from "@gym/db";
import { and, eq } from "@gym/db/orm";
import { staffMembers, type StaffRole } from "@gym/db/schema";
import { withUser } from "@gym/db";
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
import { DB } from "../tokens";

/** The organisation a request acts in, and the caller's job there. Set by TenantGuard. */
export interface TenantContext {
  tenantId: string;
  staffId: string;
  role: StaffRole;
  /** Empty = all branches. */
  branchIds: string[];
}

declare module "fastify" {
  interface FastifyRequest {
    tenant?: TenantContext;
  }
}

const ROLES = "tenancy:roles";

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
    if (!membership) throw notFound;

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
}

/** Staff with no branch list work at every branch. */
export const isBranchScoped = (tenant: TenantContext) => tenant.branchIds.length > 0;

/** May the caller act at this branch? Other branches should look like they do not exist (404). */
export const canUseBranch = (tenant: TenantContext, branchId: string) =>
  !isBranchScoped(tenant) || tenant.branchIds.includes(branchId);

/** Mark a controller as acting inside the organisation in its `:orgId` path parameter. */
export const TenantScoped = () => applyDecorators(UseGuards(TenantGuard));
