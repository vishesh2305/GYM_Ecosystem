import type { routes } from "@gym/contracts";
import { withTenant, type DbHandle, type Tx } from "@gym/db";
import { sql } from "@gym/db/orm";
import { addDays, daysBetween, todayIn } from "@gym/domain";
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Query,
} from "@nestjs/common";
import type { z } from "zod";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import { orgTimezone } from "../membership/memberships.service";
import {
  canUseBranch,
  CurrentTenant,
  isBranchScoped,
  Roles,
  TenantScoped,
  type TenantContext,
} from "../tenancy/tenant.guard";
import { READ_DB } from "../tokens";

type Out<K extends keyof typeof routes> = z.output<(typeof routes)[K]["response"]>;

const MAX_RANGE_DAYS = 366;

/** from/to in the gym's calendar, defaulting to the last 30 days. */
function rangeOf(query: { from?: string | undefined; to?: string | undefined }, today: string) {
  const to = query.to ?? today;
  const from = query.from ?? addDays(to, -29);
  if (from > to) throw new BadRequestException("from must not be after to");
  if (daysBetween(from, to) >= MAX_RANGE_DAYS)
    throw new BadRequestException(`Choose at most ${MAX_RANGE_DAYS} days`);
  return { from, to };
}

const rows = async <T>(tx: Tx, query: ReturnType<typeof sql>) =>
  (await tx.execute<T & Record<string, unknown>>(query)).rows;
const int = (v: unknown) => Number(v ?? 0);

/**
 * Owner dashboard numbers, read from the replica when one is configured (READ_DB). Every query runs under the
 * gym's RLS scope and buckets times by the gym's own time zone.
 */
@TenantScoped()
@Controller("orgs/:orgId/reports")
@Roles("owner", "manager")
export class ReportsController {
  constructor(@Inject(READ_DB) private readonly db: DbHandle) {}

  private read<T>(tenant: TenantContext, fn: (tx: Tx, tz: string, today: string) => Promise<T>) {
    if (isBranchScoped(tenant))
      throw new ForbiddenException("Reports cover the whole gym; ask an owner");
    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      const tz = await orgTimezone(tx);
      return fn(tx, tz, todayIn(tz));
    });
  }

  @Get("revenue")
  revenue(
    @CurrentTenant() tenant: TenantContext,
    @Query(new ZodPipe(contracts.revenueReport.query))
    query: z.output<typeof routes.revenueReport.query>,
  ): Promise<Out<"revenueReport">> {
    return this.read(tenant, async (tx, tz, today) => {
      const { from, to } = rangeOf(query, today);
      const local = (column: ReturnType<typeof sql>) => sql`(${column} at time zone ${tz})::date`;
      const inRange = (column: ReturnType<typeof sql>) =>
        sql`${local(column)} between ${from}::date and ${to}::date`;
      const collected = await rows<{ day: string; method: string; paise: string }>(
        tx,
        sql`select ${local(sql`captured_at`)}::text as day, method, sum(amount_paise) as paise
            from payments where status = 'captured' and ${inRange(sql`captured_at`)}
            group by 1, 2`,
      );
      const refunded = await rows<{ day: string; paise: string }>(
        tx,
        sql`select ${local(sql`created_at`)}::text as day, sum(amount_paise) as paise
            from refunds where ${inRange(sql`created_at`)} group by 1`,
      );
      const days = new Map<string, { collectedPaise: number; refundedPaise: number }>();
      const day = (d: string) => {
        const entry = days.get(d) ?? { collectedPaise: 0, refundedPaise: 0 };
        days.set(d, entry);
        return entry;
      };
      const methods = new Map<string, number>();
      for (const r of collected) {
        day(r.day).collectedPaise += int(r.paise);
        methods.set(r.method, (methods.get(r.method) ?? 0) + int(r.paise));
      }
      for (const r of refunded) day(r.day).refundedPaise += int(r.paise);
      const collectedPaise = [...methods.values()].reduce((a, b) => a + b, 0);
      const refundedPaise = refunded.reduce((a, r) => a + int(r.paise), 0);
      return {
        from,
        to,
        collectedPaise,
        refundedPaise,
        netPaise: collectedPaise - refundedPaise,
        byDay: [...days]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, v]) => ({ date, ...v })),
        byMethod: [...methods]
          .sort(([, a], [, b]) => b - a)
          .map(([method, paise]) => ({ method, collectedPaise: paise })),
      };
    });
  }

  @Get("dues")
  dues(@CurrentTenant() tenant: TenantContext): Promise<Out<"duesReport">> {
    return this.read(tenant, async (tx, _tz, today) => {
      const grouped = await rows<{ bucket: string; invoices: string; paise: string }>(
        tx,
        sql`select case
                  when due_date >= ${today}::date then 'not_due'
                  when ${today}::date - due_date <= 30 then '1_30'
                  when ${today}::date - due_date <= 60 then '31_60'
                  when ${today}::date - due_date <= 90 then '61_90'
                  else '90_plus' end as bucket,
                count(*) as invoices, sum(total_paise - paid_paise) as paise
            from invoices
            where kind = 'invoice' and status in ('issued', 'partially_paid') and total_paise > paid_paise
            group by 1`,
      );
      const order = ["not_due", "1_30", "31_60", "61_90", "90_plus"] as const;
      const buckets = order.map((bucket) => {
        const g = grouped.find((r) => r.bucket === bucket);
        return { bucket, invoices: int(g?.invoices), duePaise: int(g?.paise) };
      });
      return {
        asOf: today,
        duePaise: buckets.reduce((a, b) => a + b.duePaise, 0),
        invoices: buckets.reduce((a, b) => a + b.invoices, 0),
        buckets,
      };
    });
  }

  @Get("attendance")
  attendance(
    @CurrentTenant() tenant: TenantContext,
    @Query(new ZodPipe(contracts.attendanceReport.query))
    query: z.output<typeof routes.attendanceReport.query>,
  ): Promise<Out<"attendanceReport">> {
    if (query.branchId && !canUseBranch(tenant, query.branchId))
      throw new BadRequestException("Unknown branch");
    return this.read(tenant, async (tx, tz, today) => {
      const { from, to } = rangeOf(query, today);
      const visits = sql`from check_ins
        where (checked_in_at at time zone ${tz})::date between ${from}::date and ${to}::date
        ${query.branchId ? sql`and branch_id = ${query.branchId}` : sql``}`;
      const cells = await rows<{ weekday: string; hour: string; visits: string }>(
        tx,
        sql`select extract(dow from checked_in_at at time zone ${tz}) as weekday,
                   extract(hour from checked_in_at at time zone ${tz}) as hour,
                   count(*) as visits
            ${visits} group by 1, 2 order by 1, 2`,
      );
      const [totals] = await rows<{ visits: string; members: string }>(
        tx,
        sql`select count(*) as visits, count(distinct member_id) as members ${visits}`,
      );
      return {
        from,
        to,
        visits: int(totals?.visits),
        members: int(totals?.members),
        heatmap: cells.map((c) => ({
          weekday: int(c.weekday),
          hour: int(c.hour),
          visits: int(c.visits),
        })),
      };
    });
  }

  @Get("retention")
  retention(
    @CurrentTenant() tenant: TenantContext,
    @Query(new ZodPipe(contracts.retentionReport.query))
    query: z.output<typeof routes.retentionReport.query>,
  ): Promise<Out<"retentionReport">> {
    const months = query.months ?? 6;
    return this.read(tenant, async (tx, _tz, today) => {
      // A member "has a membership" in a month when one that really ran (not pending or cancelled) overlaps it.
      const cells = await rows<{ cohort: string; k: number; members: string; retained: string }>(
        tx,
        sql`with firsts as (
              select member_id, date_trunc('month', min(start_date))::date as cohort
              from memberships
              where status not in ('pending', 'cancelled') and start_date <= ${today}::date
              group by member_id
            ), offsets as (select generate_series(0, ${months - 1}) as k)
            select to_char(f.cohort, 'YYYY-MM') as cohort, o.k,
                   count(*) as members,
                   count(*) filter (where exists (
                     select 1 from memberships m
                     where m.member_id = f.member_id and m.status not in ('pending', 'cancelled')
                       and m.start_date < (f.cohort + make_interval(months => o.k + 1))::date
                       and m.end_date >= (f.cohort + make_interval(months => o.k))::date
                   )) as retained
            from firsts f cross join offsets o
            where f.cohort >= date_trunc('month', ${today}::date - make_interval(months => ${months - 1}))
              and f.cohort + make_interval(months => o.k) <= ${today}::date
            group by 1, 2 order by 1, 2`,
      );
      const cohorts = new Map<string, { members: number; retained: number[] }>();
      for (const c of cells) {
        const entry = cohorts.get(c.cohort) ?? { members: int(c.members), retained: [] };
        entry.retained[int(c.k)] = int(c.retained);
        cohorts.set(c.cohort, entry);
      }
      return { cohorts: [...cohorts].map(([month, v]) => ({ month, ...v })) };
    });
  }
}
