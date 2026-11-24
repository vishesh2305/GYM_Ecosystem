import type { routes } from "@gym/contracts";
import { withTenant, type DbHandle } from "@gym/db";
import { and, asc, eq, isNull } from "@gym/db/orm";
import { branches } from "@gym/db/schema";
import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import type { z } from "zod";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import { recordAudit } from "../platform/audit";
import { DB } from "../tokens";
import { toBranch, type BranchOut } from "./mappers";
import { CurrentTenant, Roles, TenantScoped, type TenantContext } from "./tenant.guard";

type BranchInput = z.output<typeof routes.createBranch.body>;

@TenantScoped()
@Controller("orgs/:orgId/branches")
export class BranchesController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  @Get()
  async list(@CurrentTenant() tenant: TenantContext): Promise<BranchOut[]> {
    const rows = await withTenant(this.db.db, tenant.tenantId, (tx) =>
      tx.select().from(branches).where(isNull(branches.deletedAt)).orderBy(asc(branches.createdAt)),
    );
    return rows.map(toBranch);
  }

  @Post()
  @Roles("owner", "manager")
  async create(
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(contracts.createBranch.body)) body: BranchInput,
  ): Promise<BranchOut> {
    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      const [branch] = await tx
        .insert(branches)
        .values({ tenantId: tenant.tenantId, ...body })
        .returning();
      if (!branch) throw new Error("branch insert returned nothing");
      await recordAudit(tx, {
        tenantId: tenant.tenantId,
        actorType: "staff",
        actorId: tenant.staffId,
        action: "branch.created",
        entityType: "branch",
        entityId: branch.id,
      });
      return toBranch(branch);
    });
  }

  @Patch(":branchId")
  @Roles("owner", "manager")
  async update(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.updateBranch.params)) params: { branchId: string },
    @Body(new ZodPipe(contracts.updateBranch.body)) body: Partial<BranchInput>,
  ): Promise<BranchOut> {
    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      const [branch] = await tx
        .update(branches)
        .set(body)
        .where(and(eq(branches.id, params.branchId), isNull(branches.deletedAt)))
        .returning();
      if (!branch) throw new NotFoundException("Branch not found");
      await recordAudit(tx, {
        tenantId: tenant.tenantId,
        actorType: "staff",
        actorId: tenant.staffId,
        action: "branch.updated",
        entityType: "branch",
        entityId: branch.id,
        data: body,
      });
      return toBranch(branch);
    });
  }
}
