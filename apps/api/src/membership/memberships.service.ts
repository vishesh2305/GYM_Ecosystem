import type { routes } from "@gym/contracts";
import { withTenant, type DbHandle, type Tx } from "@gym/db";
import { and, count, desc, eq, inArray } from "@gym/db/orm";
import { memberships, organisations, plans } from "@gym/db/schema";
import { initialStatus, LIVE_STATUSES, planEndDate, priceBreakdown, todayIn } from "@gym/domain";
import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { recordAudit } from "../platform/audit";
import { appendEvent } from "../platform/events";
import type { TenantContext } from "../tenancy/tenant.guard";
import { DB } from "../tokens";
import { membershipCreated } from "./events";
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

/** Today's date in the organisation's own time zone. */
export async function orgToday(tx: Tx): Promise<string> {
  const [org] = await tx.select({ timezone: organisations.timezone }).from(organisations);
  return todayIn(org?.timezone ?? "Asia/Kolkata");
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

      const [plan] = await tx.select().from(plans).where(eq(plans.id, input.planId));
      if (!plan || !plan.active) throw new BadRequestException("This plan is not available");
      if (plan.branchIds.length && !plan.branchIds.includes(member.homeBranchId)) {
        throw new BadRequestException("This plan is not sold at the member's home branch");
      }

      const live = await tx
        .select()
        .from(memberships)
        .where(
          and(eq(memberships.memberId, memberId), inArray(memberships.status, [...LIVE_STATUSES])),
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
        .where(eq(memberships.memberId, memberId));
      const joiningFeePaise = previous?.n ? 0 : plan.joiningFeePaise;
      const price = priceBreakdown({
        pricePaise: plan.pricePaise,
        joiningFeePaise,
        gstRateBps: plan.gstRateBps,
      });
      const endDate = planEndDate(startDate, {
        unit: plan.durationUnit,
        count: plan.durationCount,
      });

      const [row] = await tx
        .insert(memberships)
        .values({
          tenantId: tenant.tenantId,
          memberId,
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
        })
        .returning();
      if (!row) throw new Error("membership insert returned nothing");

      await appendEvent(
        tx,
        membershipCreated,
        {
          membershipId: row.id,
          memberId,
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
        actorType: "staff",
        actorId: tenant.staffId,
        action: "membership.created",
        entityType: "membership",
        entityId: row.id,
        data: { planId: plan.id, startDate, endDate, totalPaise: price.totalPaise },
      });
      return toMembership(row);
    });
  }
}
