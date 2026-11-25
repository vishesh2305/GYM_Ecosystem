import type { routes } from "@gym/contracts";
import { withTenant, type DbHandle } from "@gym/db";
import { and, desc, eq, isNull } from "@gym/db/orm";
import { supportGrants } from "@gym/db/schema";
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import type { z } from "zod";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import { recordAudit } from "../platform/audit";
import { DB } from "../tokens";
import { CurrentTenant, Roles, TenantScoped, type TenantContext } from "./tenant.guard";

type GrantOut = z.output<typeof routes.grantSupportAccess.response>;

const toGrant = (g: typeof supportGrants.$inferSelect): GrantOut => ({
  id: g.id,
  reason: g.reason,
  expiresAt: g.expiresAt.toISOString(),
  revokedAt: g.revokedAt?.toISOString() ?? null,
  views: g.views,
  lastViewedAt: g.lastViewedAt?.toISOString() ?? null,
  createdAt: g.createdAt.toISOString(),
});

/** The owner decides when the platform's support team may look at the gym (consent for impersonation). */
@TenantScoped()
@Controller("orgs/:orgId/support-access")
@Roles("owner")
export class SupportAccessController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  @Post()
  @HttpCode(201)
  grant(
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(contracts.grantSupportAccess.body))
    body: z.output<typeof routes.grantSupportAccess.body>,
  ): Promise<GrantOut> {
    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      const [row] = await tx
        .insert(supportGrants)
        .values({
          tenantId: tenant.tenantId,
          grantedBy: tenant.staffId,
          reason: body.reason,
          expiresAt: new Date(Date.now() + body.hours * 3_600_000),
        })
        .returning();
      if (!row) throw new Error("grant insert returned nothing");
      await recordAudit(tx, {
        tenantId: tenant.tenantId,
        actorType: "staff",
        actorId: tenant.staffId,
        action: "support.granted",
        entityType: "support_grant",
        entityId: row.id,
        data: body,
      });
      return toGrant(row);
    });
  }

  @Get()
  async list(@CurrentTenant() tenant: TenantContext): Promise<GrantOut[]> {
    const rows = await withTenant(this.db.db, tenant.tenantId, (tx) =>
      tx.select().from(supportGrants).orderBy(desc(supportGrants.createdAt)).limit(50),
    );
    return rows.map(toGrant);
  }

  @Delete(":grantId")
  @HttpCode(204)
  async revoke(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.revokeSupportAccess.params)) params: { grantId: string },
  ): Promise<void> {
    await withTenant(this.db.db, tenant.tenantId, async (tx) => {
      const [found] = await tx
        .select({ id: supportGrants.id })
        .from(supportGrants)
        .where(eq(supportGrants.id, params.grantId));
      if (!found) throw new NotFoundException("Support access not found");
      const [row] = await tx
        .update(supportGrants)
        .set({ revokedAt: new Date() })
        .where(and(eq(supportGrants.id, params.grantId), isNull(supportGrants.revokedAt)))
        .returning();
      if (row)
        await recordAudit(tx, {
          tenantId: tenant.tenantId,
          actorType: "staff",
          actorId: tenant.staffId,
          action: "support.revoked",
          entityType: "support_grant",
          entityId: row.id,
        });
    });
  }
}
