import type { routes } from "@gym/contracts";
import { withTenant, type Database, type DbHandle } from "@gym/db";
import { and, asc, eq, isNull } from "@gym/db/orm";
import { branches, kiosks } from "@gym/db/schema";
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
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { validate } from "uuid";
import type { z } from "zod";
import { Public } from "../auth/auth.guard";
import { contracts } from "../common/contracts";
import { hashToken } from "../common/crypto";
import { ZodPipe } from "../common/zod.pipe";
import { recordAudit } from "../platform/audit";
import {
  canUseBranch,
  CurrentTenant,
  Roles,
  TenantScoped,
  type TenantContext,
} from "../tenancy/tenant.guard";
import { DB } from "../tokens";

export type Kiosk = typeof kiosks.$inferSelect;
type KioskOut = z.output<typeof routes.listKiosks.response>[number];

const toKiosk = (k: Kiosk): KioskOut => ({
  id: k.id,
  branchId: k.branchId,
  name: k.name,
  lastSeenAt: k.lastSeenAt?.toISOString() ?? null,
  createdAt: k.createdAt.toISOString(),
});

/**
 * The device behind an `x-kiosk-token` header (`kio.<orgId>.<secret>`). The org id picks the tenant scope and
 * the hash must match a device that was not revoked. Marks the device as seen.
 */
export async function authenticateKiosk(
  db: Database,
  header: string | string[] | undefined,
): Promise<Kiosk> {
  const token = typeof header === "string" ? header : "";
  const [prefix, orgId] = token.split(".");
  const unauthorised = new UnauthorizedException("This check-in device is not registered");
  if (prefix !== "kio" || !orgId || !validate(orgId)) throw unauthorised;
  const [kiosk] = await withTenant(db, orgId, (tx) =>
    tx
      .update(kiosks)
      .set({ lastSeenAt: new Date() })
      .where(and(eq(kiosks.tokenHash, hashToken(token)), isNull(kiosks.revokedAt)))
      .returning(),
  );
  if (!kiosk) throw unauthorised;
  return kiosk;
}

@TenantScoped()
@Roles("owner", "manager")
@Controller("orgs/:orgId")
export class KiosksController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  @Post("branches/:branchId/kiosks")
  @HttpCode(201)
  create(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.createKiosk.params)) params: { branchId: string },
    @Body(new ZodPipe(contracts.createKiosk.body)) body: { name: string },
  ) {
    if (!canUseBranch(tenant, params.branchId)) throw new NotFoundException("Branch not found");
    const token = `kio.${tenant.tenantId}.${randomBytes(32).toString("base64url")}`;
    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      const [branch] = await tx
        .select({ id: branches.id })
        .from(branches)
        .where(and(eq(branches.id, params.branchId), isNull(branches.deletedAt)));
      if (!branch) throw new NotFoundException("Branch not found");
      const [row] = await tx
        .insert(kiosks)
        .values({
          tenantId: tenant.tenantId,
          branchId: params.branchId,
          name: body.name,
          tokenHash: hashToken(token),
          createdBy: tenant.staffId,
        })
        .returning();
      if (!row) throw new Error("kiosk insert returned nothing");
      await recordAudit(tx, {
        tenantId: tenant.tenantId,
        actorType: "staff",
        actorId: tenant.staffId,
        action: "kiosk.created",
        entityType: "kiosk",
        entityId: row.id,
        data: { branchId: row.branchId, name: row.name },
      });
      return { ...toKiosk(row), token };
    });
  }

  @Get("kiosks")
  async list(@CurrentTenant() tenant: TenantContext): Promise<KioskOut[]> {
    const rows = await withTenant(this.db.db, tenant.tenantId, (tx) =>
      tx.select().from(kiosks).where(isNull(kiosks.revokedAt)).orderBy(asc(kiosks.createdAt)),
    );
    return rows.filter((k) => canUseBranch(tenant, k.branchId)).map(toKiosk);
  }

  @Delete("kiosks/:kioskId")
  @HttpCode(204)
  async revoke(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.revokeKiosk.params)) params: { kioskId: string },
  ): Promise<void> {
    await withTenant(this.db.db, tenant.tenantId, async (tx) => {
      const [current] = await tx
        .select()
        .from(kiosks)
        .where(and(eq(kiosks.id, params.kioskId), isNull(kiosks.revokedAt)));
      if (!current || !canUseBranch(tenant, current.branchId))
        throw new NotFoundException("Check-in device not found");
      await tx.update(kiosks).set({ revokedAt: new Date() }).where(eq(kiosks.id, current.id));
      await recordAudit(tx, {
        tenantId: tenant.tenantId,
        actorType: "staff",
        actorId: tenant.staffId,
        action: "kiosk.revoked",
        entityType: "kiosk",
        entityId: current.id,
        data: {},
      });
    });
  }
}

/** Routes for the check-in devices themselves, authenticated by their own token instead of a user session. */
@Public()
@Controller("kiosk")
export class KioskDeviceController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  @Get()
  async whoAmI(@Req() req: FastifyRequest): Promise<z.output<typeof routes.getKiosk.response>> {
    const kiosk = await authenticateKiosk(this.db.db, req.headers["x-kiosk-token"]);
    return { id: kiosk.id, orgId: kiosk.tenantId, branchId: kiosk.branchId, name: kiosk.name };
  }
}
