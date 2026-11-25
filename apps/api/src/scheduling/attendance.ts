import type { routes } from "@gym/contracts";
import { withSystem, withTenant, type Database, type DbHandle } from "@gym/db";
import { and, eq, inArray, isNull, lt, sql } from "@gym/db/orm";
import { bookings, checkIns, classSessions, organisations } from "@gym/db/schema";
import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import type { z } from "zod";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import {
  canUseBranch,
  CurrentTenant,
  Roles,
  TenantScoped,
  type TenantContext,
} from "../tenancy/tenant.guard";
import { DB } from "../tokens";
import { withPositions } from "./bookings";

/** A check-in this long before the start counts as coming to the session. */
const EARLY_MINUTES = 60;

/**
 * Hourly, per gym: for sessions that have ended and are not settled yet, a confirmed booking becomes attended
 * when the member checked in at that branch between an hour before the start and the end, otherwise a no-show.
 * Members still waiting are released. Bookings staff already marked are left alone. Idempotent.
 */
export async function runAttendance(db: Database, now: Date = new Date()) {
  const orgs = await withSystem(db, (tx) =>
    tx.select({ id: organisations.id }).from(organisations).where(isNull(organisations.deletedAt)),
  );
  const totals = { sessions: 0, attended: 0, noShows: 0 };
  for (const org of orgs) {
    await withTenant(db, org.id, async (tx) => {
      const ended = await tx
        .update(classSessions)
        .set({ settledAt: now })
        .where(
          and(
            eq(classSessions.status, "scheduled"),
            lt(classSessions.endsAt, now),
            isNull(classSessions.settledAt),
          ),
        )
        .returning();
      for (const session of ended) {
        const earliest = new Date(session.startsAt.getTime() - EARLY_MINUTES * 60_000);
        const came = sql`exists (
          select 1 from ${checkIns}
          where ${checkIns.memberId} = ${bookings.memberId}
            and ${checkIns.branchId} = ${session.branchId}
            and ${checkIns.checkedInAt} >= ${earliest.toISOString()}
            and ${checkIns.checkedInAt} <= ${session.endsAt.toISOString()}
        )`;
        const confirmed = and(eq(bookings.sessionId, session.id), eq(bookings.status, "confirmed"));
        const attended = await tx
          .update(bookings)
          .set({ status: "attended" })
          .where(and(confirmed, came))
          .returning({ id: bookings.id });
        const missed = await tx
          .update(bookings)
          .set({ status: "no_show" })
          .where(confirmed)
          .returning({ id: bookings.id });
        await tx
          .update(bookings)
          .set({ status: "cancelled", cancelledAt: now })
          .where(and(eq(bookings.sessionId, session.id), eq(bookings.status, "waitlisted")));
        totals.attended += attended.length;
        totals.noShows += missed.length;
      }
      totals.sessions += ended.length;
    });
  }
  return totals;
}

@TenantScoped()
@Controller("orgs/:orgId/bookings/:bookingId/attendance")
export class AttendanceController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  /** Trainers mark their classes too. */
  @Post()
  @Roles("owner", "manager", "front_desk", "trainer")
  @HttpCode(200)
  mark(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.markAttendance.params)) params: { bookingId: string },
    @Body(new ZodPipe(contracts.markAttendance.body)) body: { attended: boolean },
  ): Promise<z.output<typeof routes.markAttendance.response>> {
    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      const [found] = await tx
        .select({ booking: bookings, session: classSessions })
        .from(bookings)
        .innerJoin(classSessions, eq(classSessions.id, bookings.sessionId))
        .where(eq(bookings.id, params.bookingId));
      if (!found || !canUseBranch(tenant, found.session.branchId))
        throw new NotFoundException("Booking not found");
      if (found.session.startsAt > new Date())
        throw new BadRequestException("Attendance can be marked once the session has started");
      const [row] = await tx
        .update(bookings)
        .set({ status: body.attended ? "attended" : "no_show" })
        .where(
          and(
            eq(bookings.id, found.booking.id),
            inArray(bookings.status, ["confirmed", "attended", "no_show"]),
          ),
        )
        .returning();
      if (!row) throw new BadRequestException("Only members who had a place can be marked");
      const [out] = await withPositions(tx, [row]);
      if (!out) throw new Error("booking mapping failed");
      return out;
    });
  }
}
