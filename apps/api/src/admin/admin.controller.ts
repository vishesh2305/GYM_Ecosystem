import type { routes } from "@gym/contracts";
import { withAdmin, type DbHandle, type Tx } from "@gym/db";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "@gym/db/orm";
import {
  auditLog,
  branches,
  featureFlags,
  members,
  organisations,
  staffMembers,
  users,
} from "@gym/db/schema";
import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import type { z } from "zod";
import { CurrentAuth } from "../auth/auth.guard";
import type { AuthContext } from "../auth/auth.types";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import { escapeLike } from "../membership/members.service";
import { FeatureFlags } from "../platform/feature-flags.service";
import { DB } from "../tokens";
import { PlatformAdminGuard } from "./admin.guard";

type GymOut = z.output<typeof routes.listAdminGyms.response>[number];
type FlagOut = z.output<typeof routes.listFeatureFlags.response>[number];

async function gymsWhere(tx: Tx, where: ReturnType<typeof and>): Promise<GymOut[]> {
  const rows = await tx
    .select({
      org: organisations,
      // Spelled out: inside a select list Drizzle would drop the table name and the subquery would match itself.
      branches: sql<number>`(select count(*) from ${branches} b
        where b.tenant_id = "organisations"."id" and b.deleted_at is null)::int`,
      members: sql<number>`(select count(*) from ${members} m
        where m.tenant_id = "organisations"."id" and m.deleted_at is null)::int`,
    })
    .from(organisations)
    .where(and(isNull(organisations.deletedAt), where))
    .orderBy(desc(organisations.createdAt))
    .limit(200);
  const owners = rows.length
    ? await tx
        .select({
          tenantId: staffMembers.tenantId,
          name: users.name,
          phone: users.phone,
          email: users.email,
        })
        .from(staffMembers)
        .innerJoin(users, eq(users.id, staffMembers.userId))
        .where(
          and(
            eq(staffMembers.role, "owner"),
            eq(staffMembers.status, "active"),
            inArray(
              staffMembers.tenantId,
              rows.map((r) => r.org.id),
            ),
          ),
        )
        .orderBy(asc(users.name))
    : [];
  return rows.map(({ org, ...counts }) => ({
    id: org.id,
    name: org.name,
    slug: org.slug,
    published: org.published,
    kycStatus: org.kycStatus,
    kycNote: org.kycNote,
    kycReviewedAt: org.kycReviewedAt?.toISOString() ?? null,
    ...counts,
    owners: owners
      .filter((o) => o.tenantId === org.id)
      .map(({ name, phone, email }) => ({ name, phone, email })),
    createdAt: org.createdAt.toISOString(),
  }));
}

const toFlag = (f: typeof featureFlags.$inferSelect): FlagOut => ({
  key: f.key,
  description: f.description,
  enabled: f.enabled,
  rolloutPercent: f.rolloutPercent,
  tenantIds: f.tenantIds,
  userIds: f.userIds,
});

/** The platform admin console (A16). Every change is recorded in the audit log with the admin's id. */
@Controller("admin")
@UseGuards(PlatformAdminGuard)
export class AdminController {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(FeatureFlags) private readonly flags: FeatureFlags,
  ) {}

  @Get("gyms")
  gyms(
    @Query(new ZodPipe(contracts.listAdminGyms.query))
    query: z.output<typeof routes.listAdminGyms.query>,
  ): Promise<GymOut[]> {
    const term = query.q ? `%${escapeLike(query.q)}%` : undefined;
    return withAdmin(this.db.db, (tx) =>
      gymsWhere(
        tx,
        and(
          query.kycStatus ? eq(organisations.kycStatus, query.kycStatus) : undefined,
          term ? or(ilike(organisations.name, term), ilike(organisations.slug, term)) : undefined,
        ),
      ),
    );
  }

  @Patch("gyms/:gymId/kyc")
  reviewKyc(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodPipe(contracts.reviewGymKyc.params)) params: { gymId: string },
    @Body(new ZodPipe(contracts.reviewGymKyc.body)) body: z.output<typeof routes.reviewGymKyc.body>,
  ): Promise<GymOut> {
    return withAdmin(this.db.db, async (tx) => {
      const [org] = await tx
        .update(organisations)
        .set({ kycStatus: body.status, kycNote: body.note ?? null, kycReviewedAt: new Date() })
        .where(and(eq(organisations.id, params.gymId), isNull(organisations.deletedAt)))
        .returning({ id: organisations.id });
      if (!org) throw new NotFoundException("Gym not found");
      await tx.insert(auditLog).values({
        tenantId: org.id,
        actorType: "admin",
        actorId: auth.userId,
        action: "organisation.kyc_reviewed",
        entityType: "organisation",
        entityId: org.id,
        data: body,
      });
      const [gym] = await gymsWhere(tx, eq(organisations.id, org.id));
      if (!gym) throw new NotFoundException("Gym not found");
      return gym;
    });
  }

  @Get("flags")
  async listFlags(): Promise<FlagOut[]> {
    const rows = await withAdmin(this.db.db, (tx) =>
      tx.select().from(featureFlags).orderBy(asc(featureFlags.key)),
    );
    return rows.map(toFlag);
  }

  @Put("flags/:key")
  async setFlag(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodPipe(contracts.setFeatureFlag.params)) params: { key: string },
    @Body(new ZodPipe(contracts.setFeatureFlag.body))
    body: z.output<typeof routes.setFeatureFlag.body>,
  ): Promise<FlagOut> {
    const row = await withAdmin(this.db.db, async (tx) => {
      const [flag] = await tx
        .insert(featureFlags)
        .values({ key: params.key, ...body })
        .onConflictDoUpdate({ target: featureFlags.key, set: body })
        .returning();
      await tx.insert(auditLog).values({
        actorType: "admin",
        actorId: auth.userId,
        action: "feature_flag.set",
        entityType: "feature_flag",
        entityId: params.key,
        data: body,
      });
      return flag;
    });
    if (!row) throw new Error("flag upsert returned nothing");
    await this.flags.invalidate();
    return toFlag(row);
  }
}
