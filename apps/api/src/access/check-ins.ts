import type { routes } from "@gym/contracts";
import { withTenant, type DbHandle, type Tx } from "@gym/db";
import { and, count, desc, eq, inArray, isNull, lt, ne } from "@gym/db/orm";
import { branches, checkIns, invoices, members, memberships, plans } from "@gym/db/schema";
import { entryDenial } from "@gym/domain";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { z } from "zod";
import { CurrentAuth, Public } from "../auth/auth.guard";
import type { AuthContext } from "../auth/auth.types";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import type { ApiEnv } from "../env";
import { MembersService } from "../membership/members.service";
import { orgToday } from "../membership/memberships.service";
import {
  canUseBranch,
  CurrentTenant,
  Roles,
  TenantScoped,
  type TenantContext,
} from "../tenancy/tenant.guard";
import { DB, ENV } from "../tokens";
import { authenticateKiosk } from "./kiosks";
import { myMembership } from "./my-gyms";
import { publishOccupancy } from "./occupancy";
import { checkPassCode } from "./passes";

type CheckInResult = z.output<typeof routes.deskCheckIn.response>;
type VisitOut = z.output<typeof routes.checkOut.response>;
type Visit = typeof checkIns.$inferSelect;

const HISTORY = 50;

const toVisit = (v: Visit): VisitOut => ({
  id: v.id,
  branchId: v.branchId,
  memberId: v.memberId,
  method: v.method,
  checkedInAt: v.checkedInAt.toISOString(),
  checkedOutAt: v.checkedOutAt?.toISOString() ?? null,
});

/**
 * Apply the entry rules and, if they pass, let the member in (inside the gym's tenant scope). A member already
 * inside this branch keeps their visit; one still marked inside another branch is moved here.
 */
export async function admit(
  tx: Tx,
  entry: {
    tenantId: string;
    branchId: string;
    memberId: string;
    method: Visit["method"];
    kioskId?: string;
    staffId?: string;
    autoOutHours: number;
  },
): Promise<CheckInResult> {
  const [member] = await tx
    .select({ id: members.id, name: members.name })
    .from(members)
    .where(and(eq(members.id, entry.memberId), isNull(members.deletedAt)));
  if (!member) return { allowed: false, reason: "invalid_code", member: null, visit: null };

  const today = await orgToday(tx);
  const held = await tx
    .select({
      status: memberships.status,
      startDate: memberships.startDate,
      endDate: memberships.endDate,
      branchIds: plans.branchIds,
    })
    .from(memberships)
    .innerJoin(plans, eq(plans.id, memberships.planId))
    .where(eq(memberships.memberId, member.id));
  const [overdue] = await tx
    .select({ n: count() })
    .from(invoices)
    .where(
      and(
        eq(invoices.memberId, member.id),
        eq(invoices.kind, "invoice"),
        inArray(invoices.status, ["issued", "partially_paid"]),
        lt(invoices.dueDate, today),
      ),
    );
  const reason = entryDenial({
    today,
    branchId: entry.branchId,
    memberships: held,
    overdueInvoices: overdue?.n ?? 0,
  });
  if (reason) return { allowed: false, reason, member, visit: null };

  const moved = await tx
    .update(checkIns)
    .set({ checkedOutAt: new Date() })
    .where(
      and(
        eq(checkIns.memberId, member.id),
        isNull(checkIns.checkedOutAt),
        ne(checkIns.branchId, entry.branchId),
      ),
    )
    .returning({ branchId: checkIns.branchId });
  // The one-open-visit index turns a simultaneous second scan into a no-op.
  const inserted = await tx
    .insert(checkIns)
    .values({
      tenantId: entry.tenantId,
      branchId: entry.branchId,
      memberId: member.id,
      method: entry.method,
      kioskId: entry.kioskId,
      checkedInBy: entry.staffId,
    })
    .onConflictDoNothing()
    .returning({ id: checkIns.id });
  if (inserted.length)
    await publishOccupancy(
      tx,
      entry.tenantId,
      [entry.branchId, ...moved.map((m) => m.branchId)],
      entry.autoOutHours,
    );
  const [open] = await tx
    .select()
    .from(checkIns)
    .where(and(eq(checkIns.memberId, member.id), isNull(checkIns.checkedOutAt)));
  if (!open) throw new Error("open visit missing after check-in");
  return { allowed: true, reason: null, member, visit: toVisit(open) };
}

/** Mark a visit as ended now; ending one that already ended changes nothing. */
async function leave(tx: Tx, visit: Visit, autoOutHours: number): Promise<VisitOut> {
  if (visit.checkedOutAt) return toVisit(visit);
  const [ended] = await tx
    .update(checkIns)
    .set({ checkedOutAt: new Date() })
    .where(and(eq(checkIns.id, visit.id), isNull(checkIns.checkedOutAt)))
    .returning();
  if (!ended) return toVisit(visit);
  await publishOccupancy(tx, visit.tenantId, [visit.branchId], autoOutHours);
  return toVisit(ended);
}

const history = (tx: Tx, memberId: string) =>
  tx
    .select()
    .from(checkIns)
    .where(eq(checkIns.memberId, memberId))
    .orderBy(desc(checkIns.checkedInAt))
    .limit(HISTORY)
    .then((rows) => rows.map(toVisit));

@Public()
@Controller("kiosk/check-ins")
export class KioskCheckInsController {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  @Post()
  @HttpCode(200)
  async checkIn(
    @Req() req: FastifyRequest,
    @Body(new ZodPipe(contracts.kioskCheckIn.body)) body: { code: string },
  ): Promise<CheckInResult> {
    const kiosk = await authenticateKiosk(this.db.db, req.headers["x-kiosk-token"]);
    return withTenant(this.db.db, kiosk.tenantId, async (tx) => {
      const pass = await checkPassCode(tx, body.code, this.env.AUTH_ENCRYPTION_KEY);
      if (!pass.ok) return { allowed: false, reason: pass.reason, member: null, visit: null };
      return admit(tx, {
        tenantId: kiosk.tenantId,
        branchId: kiosk.branchId,
        memberId: pass.memberId,
        method: "qr",
        kioskId: kiosk.id,
        autoOutHours: this.env.CHECKIN_AUTO_OUT_HOURS,
      });
    });
  }
}

@TenantScoped()
@Roles("owner", "manager", "front_desk")
@Controller("orgs/:orgId")
export class DeskCheckInsController {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(MembersService) private readonly members: MembersService,
  ) {}

  /** Members may visit any branch their plan covers, so this does not limit staff to members of their branch. */
  @Post("branches/:branchId/check-ins")
  @HttpCode(200)
  checkIn(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.deskCheckIn.params)) params: { branchId: string },
    @Body(new ZodPipe(contracts.deskCheckIn.body)) body: { memberId: string },
  ): Promise<CheckInResult> {
    if (!canUseBranch(tenant, params.branchId)) throw new NotFoundException("Branch not found");
    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      const [branch] = await tx
        .select({ id: branches.id })
        .from(branches)
        .where(and(eq(branches.id, params.branchId), isNull(branches.deletedAt)));
      if (!branch) throw new NotFoundException("Branch not found");
      const result = await admit(tx, {
        tenantId: tenant.tenantId,
        branchId: params.branchId,
        memberId: body.memberId,
        method: "desk",
        staffId: tenant.staffId,
        autoOutHours: this.env.CHECKIN_AUTO_OUT_HOURS,
      });
      if (!result.member) throw new NotFoundException("Member not found");
      return result;
    });
  }

  @Post("check-ins/:checkInId/check-out")
  @HttpCode(200)
  checkOut(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.checkOut.params)) params: { checkInId: string },
  ): Promise<VisitOut> {
    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      const [visit] = await tx.select().from(checkIns).where(eq(checkIns.id, params.checkInId));
      if (!visit || !canUseBranch(tenant, visit.branchId))
        throw new NotFoundException("Visit not found");
      return leave(tx, visit, this.env.CHECKIN_AUTO_OUT_HOURS);
    });
  }

  @Get("members/:memberId/check-ins")
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.listMemberCheckIns.params)) params: { memberId: string },
  ): Promise<VisitOut[]> {
    await this.members.find(tenant, params.memberId);
    return withTenant(this.db.db, tenant.tenantId, (tx) => history(tx, params.memberId));
  }
}

@Controller("me/gyms/:orgId")
export class MyVisitsController {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  @Post("check-out")
  @HttpCode(200)
  async checkOut(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodPipe(contracts.checkMeOut.params)) params: { orgId: string },
  ): Promise<VisitOut> {
    const gym = await myMembership(this.db.db, auth.userId, params.orgId);
    return withTenant(this.db.db, gym.orgId, async (tx) => {
      const [open] = await tx
        .select()
        .from(checkIns)
        .where(and(eq(checkIns.memberId, gym.memberId), isNull(checkIns.checkedOutAt)));
      if (!open) throw new NotFoundException("You are not checked in");
      return leave(tx, open, this.env.CHECKIN_AUTO_OUT_HOURS);
    });
  }

  @Get("check-ins")
  async list(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodPipe(contracts.listMyCheckIns.params)) params: { orgId: string },
  ): Promise<VisitOut[]> {
    const gym = await myMembership(this.db.db, auth.userId, params.orgId);
    return withTenant(this.db.db, gym.orgId, (tx) => history(tx, gym.memberId));
  }
}
