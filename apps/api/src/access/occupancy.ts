import type { routes } from "@gym/contracts";
import { withSystem, withTenant, type Database, type DbHandle, type Tx } from "@gym/db";
import { and, asc, count, gt, isNull, lt, sql } from "@gym/db/orm";
import { branches, checkIns, organisations } from "@gym/db/schema";
import { Controller, Get, Inject, Param } from "@nestjs/common";
import { z } from "zod";
import { CurrentAuth } from "../auth/auth.guard";
import type { AuthContext } from "../auth/auth.types";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import type { ApiEnv } from "../env";
import { appendEvent, defineEvent } from "../platform/events";
import {
  canUseBranch,
  CurrentTenant,
  TenantScoped,
  type TenantContext,
} from "../tenancy/tenant.guard";
import { DB, ENV } from "../tokens";
import { myMembership } from "./my-gyms";

type OccupancyOut = z.output<typeof routes.getOccupancy.response>;

/** For live screens (realtime channel `branch:{id}:occupancy`): the new head count after any change. */
export const occupancyChanged = defineEvent(
  "branch.occupancy_changed",
  z.object({ branchId: z.uuid(), count: z.number().int() }),
);

/** Members inside: open visits that started less than `autoOutHours` ago (older ones are auto checked out). */
export async function countInside(
  tx: Tx,
  autoOutHours: number,
  now: Date = new Date(),
): Promise<Map<string, number>> {
  const since = new Date(now.getTime() - autoOutHours * 3_600_000);
  const rows = await tx
    .select({ branchId: checkIns.branchId, n: count() })
    .from(checkIns)
    .where(and(isNull(checkIns.checkedOutAt), gt(checkIns.checkedInAt, since)))
    .groupBy(checkIns.branchId);
  return new Map(rows.map((r) => [r.branchId, r.n]));
}

/** Publish the head count of each branch that just changed (inside the same transaction as the change). */
export async function publishOccupancy(
  tx: Tx,
  tenantId: string,
  branchIds: readonly string[],
  autoOutHours: number,
): Promise<void> {
  if (!branchIds.length) return;
  const inside = await countInside(tx, autoOutHours);
  for (const branchId of new Set(branchIds)) {
    await appendEvent(
      tx,
      occupancyChanged,
      { branchId, count: inside.get(branchId) ?? 0 },
      tenantId,
    );
  }
}

/**
 * Hourly: visits older than `autoOutHours` with no check-out end at check-in + `autoOutHours`, and the
 * branches concerned publish their new count. Idempotent.
 */
export async function runAutoCheckOut(db: Database, autoOutHours: number, now: Date = new Date()) {
  const orgs = await withSystem(db, (tx) =>
    tx.select({ id: organisations.id }).from(organisations).where(isNull(organisations.deletedAt)),
  );
  let checkedOut = 0;
  const cutoff = new Date(now.getTime() - autoOutHours * 3_600_000);
  for (const org of orgs) {
    await withTenant(db, org.id, async (tx) => {
      const ended = await tx
        .update(checkIns)
        .set({
          checkedOutAt: sql`${checkIns.checkedInAt} + make_interval(hours => ${autoOutHours})`,
        })
        .where(and(isNull(checkIns.checkedOutAt), lt(checkIns.checkedInAt, cutoff)))
        .returning({ branchId: checkIns.branchId });
      checkedOut += ended.length;
      await publishOccupancy(
        tx,
        org.id,
        ended.map((e) => e.branchId),
        autoOutHours,
      );
    });
  }
  return { checkedOut };
}

async function occupancyOf(
  tx: Tx,
  autoOutHours: number,
  visible: (branchId: string) => boolean,
): Promise<OccupancyOut> {
  const inside = await countInside(tx, autoOutHours);
  const all = await tx
    .select({ id: branches.id, name: branches.name })
    .from(branches)
    .where(isNull(branches.deletedAt))
    .orderBy(asc(branches.name));
  return {
    asOf: new Date().toISOString(),
    branches: all
      .filter((b) => visible(b.id))
      .map((b) => ({ branchId: b.id, name: b.name, count: inside.get(b.id) ?? 0 })),
  };
}

/** Any staff role, for their branches. */
@TenantScoped()
@Controller("orgs/:orgId/occupancy")
export class OccupancyController {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  @Get()
  get(@CurrentTenant() tenant: TenantContext): Promise<OccupancyOut> {
    return withTenant(this.db.db, tenant.tenantId, (tx) =>
      occupancyOf(tx, this.env.CHECKIN_AUTO_OUT_HOURS, (id) => canUseBranch(tenant, id)),
    );
  }
}

@Controller("me/gyms/:orgId/occupancy")
export class MyGymOccupancyController {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  @Get()
  async get(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodPipe(contracts.getMyGymOccupancy.params)) params: { orgId: string },
  ): Promise<OccupancyOut> {
    const gym = await myMembership(this.db.db, auth.userId, params.orgId);
    return withTenant(this.db.db, gym.orgId, (tx) =>
      occupancyOf(tx, this.env.CHECKIN_AUTO_OUT_HOURS, () => true),
    );
  }
}
