import type { routes } from "@gym/contracts";
import { withTenant, type DbHandle, type Tx } from "@gym/db";
import { and, count, desc, eq, inArray, isNull } from "@gym/db/orm";
import { membershipFreezes, memberships, organisations, plans } from "@gym/db/schema";
import {
  addDays,
  canTransition,
  initialStatus,
  LIVE_STATUSES,
  planEndDate,
  priceBreakdown,
  prorateCredit,
  todayIn,
  unfreezeSplit,
  type MembershipStatus,
} from "@gym/domain";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { z } from "zod";
import { recordAudit } from "../platform/audit";
import { appendEvent } from "../platform/events";
import type { TenantContext } from "../tenancy/tenant.guard";
import { DB } from "../tokens";
import { membershipCancelled, membershipCreated, membershipPlanChanged } from "./events";
import { MembersService } from "./members.service";

export type MembershipOut = z.output<typeof routes.enrolMember.response>;

export const toMembership = (m: typeof memberships.$inferSelect): MembershipOut => ({
  id: m.id,
  memberId: m.memberId,
  planId: m.planId,
  planName: m.planName,
  status: m.status,
  startDate: m.startDate,
  endDate: m.endDate,
  isTrial: m.isTrial,
  pricePaise: m.pricePaise,
  joiningFeePaise: m.joiningFeePaise,
  gstPaise: m.gstPaise,
  totalPaise: m.totalPaise,
  freezesUsed: m.freezesUsed,
  maxFreezes: m.maxFreezes,
  cancelledAt: m.cancelledAt?.toISOString() ?? null,
  cancelReason: m.cancelReason,
  createdAt: m.createdAt.toISOString(),
});

/** The organisation's time zone (inside its tenant scope). */
export async function orgTimezone(tx: Tx): Promise<string> {
  const [org] = await tx.select({ timezone: organisations.timezone }).from(organisations);
  return org?.timezone ?? "Asia/Kolkata";
}

/** Today's date in the organisation's own time zone. */
export async function orgToday(tx: Tx): Promise<string> {
  return todayIn(await orgTimezone(tx));
}

/**
 * Sell a plan inside the caller's transaction. Staff sales record who sold it; the AutoPay renewal job passes
 * `staffId: null` and the mandate it renews under.
 */
export async function sellPlan(
  tx: Tx,
  tenant: { tenantId: string; staffId: string | null },
  member: { id: string; homeBranchId: string },
  planId: string,
  startDate: string,
  today: string,
  renewedByMandateId: string | null = null,
) {
  const [plan] = await tx.select().from(plans).where(eq(plans.id, planId));
  if (!plan || !plan.active) throw new BadRequestException("This plan is not available");
  if (plan.branchIds.length && !plan.branchIds.includes(member.homeBranchId)) {
    throw new BadRequestException("This plan is not sold at the member's home branch");
  }

  const live = await tx
    .select()
    .from(memberships)
    .where(
      and(eq(memberships.memberId, member.id), inArray(memberships.status, [...LIVE_STATUSES])),
    );
  const clash = live.find((m) => m.endDate >= startDate);
  if (clash) {
    throw new ConflictException(
      `The member already has a membership until ${clash.endDate}; start the new one after that`,
    );
  }

  const [previous] = await tx
    .select({ n: count() })
    .from(memberships)
    .where(eq(memberships.memberId, member.id));
  const joiningFeePaise = previous?.n ? 0 : plan.joiningFeePaise;
  const price = priceBreakdown({
    pricePaise: plan.pricePaise,
    joiningFeePaise,
    gstRateBps: plan.gstRateBps,
  });
  const endDate = planEndDate(startDate, { unit: plan.durationUnit, count: plan.durationCount });

  const [row] = await tx
    .insert(memberships)
    .values({
      tenantId: tenant.tenantId,
      memberId: member.id,
      planId: plan.id,
      planName: plan.name,
      status: initialStatus({ startDate, today, isTrial: plan.isTrial }),
      startDate,
      endDate,
      isTrial: plan.isTrial,
      pricePaise: price.pricePaise,
      joiningFeePaise: price.joiningFeePaise,
      gstRateBps: plan.gstRateBps,
      gstPaise: price.gstPaise,
      totalPaise: price.totalPaise,
      maxFreezes: plan.maxFreezes,
      maxFreezeDays: plan.maxFreezeDays,
      createdBy: tenant.staffId,
      renewedByMandateId,
    })
    .returning();
  if (!row) throw new Error("membership insert returned nothing");

  await appendEvent(
    tx,
    membershipCreated,
    {
      membershipId: row.id,
      memberId: member.id,
      planId: plan.id,
      startDate,
      endDate,
      pricePaise: price.pricePaise,
      joiningFeePaise: price.joiningFeePaise,
      gstRateBps: plan.gstRateBps,
      gstPaise: price.gstPaise,
      totalPaise: price.totalPaise,
    },
    tenant.tenantId,
  );
  await recordAudit(tx, {
    tenantId: tenant.tenantId,
    actorType: tenant.staffId ? "staff" : "system",
    actorId: tenant.staffId,
    action: "membership.created",
    entityType: "membership",
    entityId: row.id,
    data: { planId: plan.id, startDate, endDate, totalPaise: price.totalPaise },
  });
  return row;
}

@Injectable()
export class MembershipsService {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(MembersService) private readonly members: MembersService,
  ) {}

  async list(tenant: TenantContext, memberId: string): Promise<MembershipOut[]> {
    await this.members.find(tenant, memberId);
    const rows = await withTenant(this.db.db, tenant.tenantId, (tx) =>
      tx
        .select()
        .from(memberships)
        .where(eq(memberships.memberId, memberId))
        .orderBy(desc(memberships.startDate)),
    );
    return rows.map(toMembership);
  }

  /**
   * Sell a plan to a member. The joining fee is charged only on a member's first membership, and a new
   * membership may not overlap one that is still running (renewals start after it ends).
   */
  async enrol(
    tenant: TenantContext,
    memberId: string,
    input: { planId: string; startDate?: string | undefined },
  ): Promise<MembershipOut> {
    const member = await this.members.find(tenant, memberId);
    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      const today = await orgToday(tx);
      const startDate = input.startDate ?? today;
      if (startDate < today) throw new BadRequestException("A membership cannot start in the past");
      return toMembership(await sellPlan(tx, tenant, member, input.planId, startDate, today));
    });
  }

  /**
   * Move a member to another plan from today. The unused part of the current plan's price becomes a credit
   * for billing; the current membership is cancelled as "changed plan". Paused memberships must be resumed first.
   */
  async changePlan(tenant: TenantContext, membershipId: string, planId: string) {
    const current = await this.findVisible(tenant, membershipId);
    if (!["active", "trial", "pending"].includes(current.status)) {
      throw new ConflictException(`A ${current.status} membership cannot change plan`);
    }
    const member = await this.members.find(tenant, current.memberId);
    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      const today = await orgToday(tx);
      const { creditPaise } = prorateCredit({ ...current, today });
      const [old] = await tx
        .update(memberships)
        .set({ status: "cancelled", cancelledAt: new Date(), cancelReason: "changed_plan" })
        .where(and(eq(memberships.id, membershipId), eq(memberships.status, current.status)))
        .returning();
      if (!old)
        throw new ConflictException(
          "The membership was changed at the same time; please try again",
        );
      const next = await sellPlan(tx, tenant, member, planId, today, today);
      await appendEvent(
        tx,
        membershipPlanChanged,
        { oldMembershipId: old.id, newMembershipId: next.id, memberId: member.id, creditPaise },
        tenant.tenantId,
      );
      await recordAudit(tx, {
        tenantId: tenant.tenantId,
        actorType: "staff",
        actorId: tenant.staffId,
        action: "membership.plan_changed",
        entityType: "membership",
        entityId: old.id,
        data: { newMembershipId: next.id, creditPaise },
      });
      return { previous: toMembership(old), current: toMembership(next), creditPaise };
    });
  }

  /** Pause an active membership; its end date moves back by the frozen days. */
  async freeze(
    tenant: TenantContext,
    membershipId: string,
    input: { days: number; reason?: string | undefined },
  ) {
    return this.change(tenant, membershipId, "frozen", async (tx, current, today) => {
      if (current.maxFreezes === 0)
        throw new BadRequestException("This plan does not allow pausing");
      if (current.freezesUsed >= current.maxFreezes) {
        throw new BadRequestException(`This membership has used all ${current.maxFreezes} pauses`);
      }
      if (input.days > current.maxFreezeDays) {
        throw new BadRequestException(
          `A pause can last at most ${current.maxFreezeDays} days on this plan`,
        );
      }
      await tx.insert(membershipFreezes).values({
        tenantId: tenant.tenantId,
        membershipId,
        startsOn: today,
        plannedEndsOn: addDays(today, input.days - 1),
        days: input.days,
        reason: input.reason,
        createdBy: tenant.staffId,
      });
      return {
        endDate: addDays(current.endDate, input.days),
        freezesUsed: current.freezesUsed + 1,
      };
    });
  }

  /** End a pause early: unused days come off the end date; a same-day unfreeze also gives the pause back. */
  async unfreeze(tenant: TenantContext, membershipId: string) {
    return this.change(tenant, membershipId, "active", async (tx, current, today) => {
      const [freeze] = await tx
        .select()
        .from(membershipFreezes)
        .where(
          and(eq(membershipFreezes.membershipId, membershipId), isNull(membershipFreezes.endedOn)),
        );
      if (!freeze) throw new ConflictException("This membership is not paused");
      const { usedDays, unusedDays } = unfreezeSplit({
        startsOn: freeze.startsOn,
        days: freeze.days,
        today,
      });
      await tx
        .update(membershipFreezes)
        .set({ endedOn: addDays(freeze.startsOn, Math.max(usedDays, 1) - 1) })
        .where(eq(membershipFreezes.id, freeze.id));
      return {
        endDate: addDays(current.endDate, -unusedDays),
        freezesUsed: usedDays === 0 ? current.freezesUsed - 1 : current.freezesUsed,
      };
    });
  }

  /** Cancel any membership that is not already finished; an open pause is closed too. */
  async cancel(tenant: TenantContext, membershipId: string, reason: string) {
    return this.change(tenant, membershipId, "cancelled", async (tx, current, today) => {
      await tx
        .update(membershipFreezes)
        .set({ endedOn: today })
        .where(
          and(eq(membershipFreezes.membershipId, membershipId), isNull(membershipFreezes.endedOn)),
        );
      await appendEvent(
        tx,
        membershipCancelled,
        { membershipId, memberId: current.memberId, reason },
        tenant.tenantId,
      );
      return { cancelledAt: new Date(), cancelReason: reason };
    });
  }

  /** Load a membership the caller may see, check the status change is allowed, apply it, audit it. */
  private async change(
    tenant: TenantContext,
    membershipId: string,
    to: MembershipStatus,
    apply: (
      tx: Tx,
      current: typeof memberships.$inferSelect,
      today: string,
    ) => Promise<Partial<typeof memberships.$inferInsert>>,
  ): Promise<MembershipOut> {
    const current = await this.findVisible(tenant, membershipId);
    if (!canTransition(current.status, to)) {
      throw new ConflictException(`A ${current.status} membership cannot become ${to}`);
    }
    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      const changes = await apply(tx, current, await orgToday(tx));
      const [row] = await tx
        .update(memberships)
        .set({ ...changes, status: to })
        .where(and(eq(memberships.id, membershipId), eq(memberships.status, current.status)))
        .returning();
      if (!row)
        throw new ConflictException(
          "The membership was changed at the same time; please try again",
        );
      await recordAudit(tx, {
        tenantId: tenant.tenantId,
        actorType: "staff",
        actorId: tenant.staffId,
        action: `membership.${to}`,
        entityType: "membership",
        entityId: membershipId,
        data: { from: current.status, endDate: row.endDate },
      });
      return toMembership(row);
    });
  }

  private async findVisible(tenant: TenantContext, membershipId: string) {
    const [row] = await withTenant(this.db.db, tenant.tenantId, (tx) =>
      tx.select().from(memberships).where(eq(memberships.id, membershipId)),
    );
    if (!row) throw new NotFoundException("Membership not found");
    await this.members.find(tenant, row.memberId); // 404 if the member is outside the caller's branches
    return row;
  }
}
