import type { routes } from "@gym/contracts";
import { withTenant, type DbHandle } from "@gym/db";
import { asc, eq } from "@gym/db/orm";
import { plans } from "@gym/db/schema";
import { priceBreakdown } from "@gym/domain";
import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import type { z } from "zod";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import { recordAudit } from "../platform/audit";
import {
  assertBranchesExist,
  assertWithinMyBranches,
  overlapsMyBranches,
} from "../tenancy/branch-checks";
import { CurrentTenant, Roles, TenantScoped, type TenantContext } from "../tenancy/tenant.guard";
import { DB } from "../tokens";

type PlanOut = z.output<typeof routes.updatePlan.response>;

export const toPlan = (p: typeof plans.$inferSelect): PlanOut => {
  const price = priceBreakdown(p);
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    durationUnit: p.durationUnit,
    durationCount: p.durationCount,
    pricePaise: p.pricePaise,
    gstRateBps: p.gstRateBps as PlanOut["gstRateBps"],
    joiningFeePaise: p.joiningFeePaise,
    isTrial: p.isTrial,
    branchIds: p.branchIds,
    maxFreezes: p.maxFreezes,
    maxFreezeDays: p.maxFreezeDays,
    active: p.active,
    gstPaise: price.gstPaise,
    totalPaise: price.totalPaise,
  };
};

const OUTSIDE = "You can only manage plans for your own branches";

@TenantScoped()
@Controller("orgs/:orgId/plans")
export class PlansController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  @Get()
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query(new ZodPipe(contracts.listPlans.query)) query: z.output<typeof routes.listPlans.query>,
  ): Promise<PlanOut[]> {
    const rows = await withTenant(this.db.db, tenant.tenantId, (tx) =>
      tx
        .select()
        .from(plans)
        .where(query.includeArchived ? undefined : eq(plans.active, true))
        .orderBy(asc(plans.createdAt)),
    );
    return rows.filter((p) => overlapsMyBranches(tenant, p.branchIds)).map(toPlan);
  }

  @Post()
  @Roles("owner", "manager")
  async create(
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(contracts.createPlan.body)) body: z.output<typeof routes.createPlan.body>,
  ): Promise<PlanOut> {
    assertWithinMyBranches(tenant, body.branchIds, OUTSIDE);
    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      await assertBranchesExist(tx, body.branchIds);
      const [row] = await tx
        .insert(plans)
        .values({ tenantId: tenant.tenantId, ...body })
        .returning();
      if (!row) throw new Error("plan insert returned nothing");
      await recordAudit(tx, {
        tenantId: tenant.tenantId,
        actorType: "staff",
        actorId: tenant.staffId,
        action: "plan.created",
        entityType: "plan",
        entityId: row.id,
        data: { name: row.name, pricePaise: row.pricePaise },
      });
      return toPlan(row);
    });
  }

  @Patch(":planId")
  @Roles("owner", "manager")
  async update(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.updatePlan.params)) params: { planId: string },
    @Body(new ZodPipe(contracts.updatePlan.body)) body: z.output<typeof routes.updatePlan.body>,
  ): Promise<PlanOut> {
    if (body.branchIds) assertWithinMyBranches(tenant, body.branchIds, OUTSIDE);
    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      const [current] = await tx.select().from(plans).where(eq(plans.id, params.planId));
      // A branch-scoped manager may only touch plans sold exclusively at their branches.
      const mine =
        current &&
        (!tenant.branchIds.length ||
          (current.branchIds.length > 0 &&
            current.branchIds.every((id) => tenant.branchIds.includes(id))));
      if (!current || !mine) throw new NotFoundException("Plan not found");
      if (body.branchIds) await assertBranchesExist(tx, body.branchIds);
      const [row] = await tx.update(plans).set(body).where(eq(plans.id, params.planId)).returning();
      if (!row) throw new NotFoundException("Plan not found");
      await recordAudit(tx, {
        tenantId: tenant.tenantId,
        actorType: "staff",
        actorId: tenant.staffId,
        action: "plan.updated",
        entityType: "plan",
        entityId: row.id,
        data: body,
      });
      return toPlan(row);
    });
  }
}
