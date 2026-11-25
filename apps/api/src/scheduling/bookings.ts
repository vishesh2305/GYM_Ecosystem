import type { routes } from "@gym/contracts";
import { withTenant, type DbHandle, type Tx } from "@gym/db";
import { and, asc, count, desc, eq, inArray, isNull } from "@gym/db/orm";
import { bookings, classSessions, members } from "@gym/db/schema";
import { isLateCancel, todayIn, type EntryDenial } from "@gym/domain";
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { z } from "zod";
import { entryDenialFor } from "../access/check-ins";
import { myMembership } from "../access/my-gyms";
import { CurrentAuth } from "../auth/auth.guard";
import type { AuthContext } from "../auth/auth.types";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import { orgTimezone } from "../membership/memberships.service";
import { appendEvent, defineEvent } from "../platform/events";
import {
  canUseBranch,
  CurrentTenant,
  Roles,
  TenantScoped,
  type TenantContext,
} from "../tenancy/tenant.guard";
import { DB } from "../tokens";
import { sessionRange, toSession, type Session, type SessionOut } from "./timetable";

type Booking = typeof bookings.$inferSelect;
type BookingOut = z.output<typeof routes.bookSession.response>;

const LIVE: readonly Booking["status"][] = ["confirmed", "waitlisted"];
const HISTORY = 50;

/** Shown when the membership rules refuse a booking. */
const REFUSALS: Record<EntryDenial, string> = {
  invalid_code: "Member not found",
  code_already_used: "Member not found",
  no_active_membership: "The member has no membership running on the day of this session",
  membership_paused: "The member's membership is paused on the day of this session",
  wrong_branch: "The member's plan does not include this branch",
  dues_unpaid: "The member has unpaid dues past their due date",
};

/** Delivered by notifications (A14): a waiting member got a place. */
export const bookingPromoted = defineEvent(
  "booking.promoted",
  z.object({
    bookingId: z.uuid(),
    sessionId: z.uuid(),
    memberId: z.uuid(),
    name: z.string(),
    startsAt: z.iso.datetime(),
  }),
);

const toBooking = (b: Booking, waitlistPosition: number | null = null): BookingOut => ({
  id: b.id,
  sessionId: b.sessionId,
  memberId: b.memberId,
  status: b.status,
  waitlistPosition: b.status === "waitlisted" ? waitlistPosition : null,
  promotedAt: b.promotedAt?.toISOString() ?? null,
  cancelledAt: b.cancelledAt?.toISOString() ?? null,
  createdAt: b.createdAt.toISOString(),
});

/** Bookings with their place in line (1 = next) for those waiting. */
export async function withPositions(tx: Tx, rows: readonly Booking[]): Promise<BookingOut[]> {
  const sessionIds = [
    ...new Set(rows.filter((r) => r.status === "waitlisted").map((r) => r.sessionId)),
  ];
  const positions = new Map<string, number>();
  if (sessionIds.length) {
    const waiting = await tx
      .select({ id: bookings.id, sessionId: bookings.sessionId })
      .from(bookings)
      .where(and(inArray(bookings.sessionId, sessionIds), eq(bookings.status, "waitlisted")))
      .orderBy(asc(bookings.id));
    const seen = new Map<string, number>();
    for (const w of waiting) {
      const n = (seen.get(w.sessionId) ?? 0) + 1;
      seen.set(w.sessionId, n);
      positions.set(w.id, n);
    }
  }
  return rows.map((r) => toBooking(r, positions.get(r.id) ?? null));
}

/** Places taken and members waiting per session. */
async function placesTaken(tx: Tx, sessionIds: readonly string[]) {
  const places = new Map<string, { booked: number; waitlisted: number }>();
  if (!sessionIds.length) return places;
  const rows = await tx
    .select({ sessionId: bookings.sessionId, status: bookings.status, n: count() })
    .from(bookings)
    .where(and(inArray(bookings.sessionId, [...sessionIds]), inArray(bookings.status, [...LIVE])))
    .groupBy(bookings.sessionId, bookings.status);
  for (const r of rows) {
    const p = places.get(r.sessionId) ?? { booked: 0, waitlisted: 0 };
    if (r.status === "confirmed") p.booked = r.n;
    else p.waitlisted = r.n;
    places.set(r.sessionId, p);
  }
  return places;
}

export async function sessionsWithPlaces(tx: Tx, rows: readonly Session[]): Promise<SessionOut[]> {
  const places = await placesTaken(
    tx,
    rows.map((s) => s.id),
  );
  return rows.map((s) => toSession(s, places.get(s.id)));
}

/** Lock a session for a change to its places (every booking change goes through this lock). */
async function lockSession(tx: Tx, sessionId: string): Promise<Session> {
  const [session] = await tx
    .select()
    .from(classSessions)
    .where(eq(classSessions.id, sessionId))
    .for("update");
  if (!session) throw new NotFoundException("Session not found");
  return session;
}

/** Give free places to the members waiting, first come first served. Call with the session locked. */
async function fillPlaces(tx: Tx, session: Session, now: Date = new Date()): Promise<void> {
  if (session.status !== "scheduled" || session.startsAt <= now) return;
  const [taken] = await tx
    .select({ n: count() })
    .from(bookings)
    .where(and(eq(bookings.sessionId, session.id), eq(bookings.status, "confirmed")));
  const free = session.capacity - (taken?.n ?? 0);
  if (free <= 0) return;
  const next = await tx
    .select()
    .from(bookings)
    .where(and(eq(bookings.sessionId, session.id), eq(bookings.status, "waitlisted")))
    .orderBy(asc(bookings.id))
    .limit(free);
  for (const b of next) {
    await tx
      .update(bookings)
      .set({ status: "confirmed", promotedAt: now })
      .where(eq(bookings.id, b.id));
    await appendEvent(
      tx,
      bookingPromoted,
      {
        bookingId: b.id,
        sessionId: session.id,
        memberId: b.memberId,
        name: session.name,
        startsAt: session.startsAt.toISOString(),
      },
      session.tenantId,
    );
  }
}

/** Fill a session's free places from its waitlist (for example after its capacity went up). */
export async function refillSession(tx: Tx, sessionId: string): Promise<void> {
  await fillPlaces(tx, await lockSession(tx, sessionId));
}

/**
 * Book a member into a session: a place while there is one, otherwise the waitlist. The session row is locked,
 * so simultaneous bookings never exceed the capacity. Booking again returns the existing booking.
 */
export async function book(
  tx: Tx,
  input: { sessionId: string; memberId: string; staffId?: string },
  now: Date = new Date(),
): Promise<BookingOut> {
  const session = await lockSession(tx, input.sessionId);
  if (session.status === "cancelled")
    throw new BadRequestException("This session has been cancelled");
  if (session.startsAt <= now) throw new BadRequestException("This session has already started");
  const [existing] = await tx
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.sessionId, session.id),
        eq(bookings.memberId, input.memberId),
        inArray(bookings.status, [...LIVE]),
      ),
    );
  if (existing) return (await withPositions(tx, [existing]))[0] ?? toBooking(existing);

  const [member] = await tx
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.id, input.memberId), isNull(members.deletedAt)));
  if (!member) throw new NotFoundException("Member not found");
  const onDate = todayIn(await orgTimezone(tx), session.startsAt);
  const refusal = await entryDenialFor(tx, member.id, session.branchId, onDate);
  if (refusal) throw new BadRequestException(REFUSALS[refusal]);

  const [taken] = await tx
    .select({ n: count() })
    .from(bookings)
    .where(and(eq(bookings.sessionId, session.id), eq(bookings.status, "confirmed")));
  const [row] = await tx
    .insert(bookings)
    .values({
      tenantId: session.tenantId,
      sessionId: session.id,
      memberId: member.id,
      status: (taken?.n ?? 0) < session.capacity ? "confirmed" : "waitlisted",
      bookedBy: input.staffId,
    })
    .returning();
  if (!row) throw new Error("booking insert returned nothing");
  return (await withPositions(tx, [row]))[0] ?? toBooking(row);
}

/** Cancel a live booking; a freed place goes to the first member waiting. Late inside the window. */
export async function cancel(
  tx: Tx,
  booking: Booking,
  now: Date = new Date(),
): Promise<BookingOut> {
  const session = await lockSession(tx, booking.sessionId);
  const [current] = await tx.select().from(bookings).where(eq(bookings.id, booking.id));
  if (!current || !LIVE.includes(current.status)) return toBooking(current ?? booking);
  const late =
    current.status === "confirmed" &&
    isLateCancel(session.startsAt, session.cancelWindowMinutes, now);
  const [row] = await tx
    .update(bookings)
    .set({ status: late ? "late_cancelled" : "cancelled", cancelledAt: now })
    .where(eq(bookings.id, current.id))
    .returning();
  if (current.status === "confirmed") await fillPlaces(tx, session, now);
  return toBooking(row ?? current);
}

@TenantScoped()
@Controller("orgs/:orgId")
export class BookingsController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  @Post("sessions/:sessionId/bookings")
  @Roles("owner", "manager", "front_desk")
  @HttpCode(201)
  book(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.bookSession.params)) params: { sessionId: string },
    @Body(new ZodPipe(contracts.bookSession.body)) body: { memberId: string },
  ): Promise<BookingOut> {
    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      await this.visibleSession(tx, tenant, params.sessionId);
      return book(tx, {
        sessionId: params.sessionId,
        memberId: body.memberId,
        staffId: tenant.staffId,
      });
    });
  }

  @Get("sessions/:sessionId/bookings")
  list(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.listSessionBookings.params)) params: { sessionId: string },
  ): Promise<z.output<typeof routes.listSessionBookings.response>> {
    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      await this.visibleSession(tx, tenant, params.sessionId);
      const rows = await tx
        .select({ booking: bookings, memberName: members.name })
        .from(bookings)
        .innerJoin(members, eq(members.id, bookings.memberId))
        .where(eq(bookings.sessionId, params.sessionId))
        .orderBy(asc(bookings.id));
      const out = await withPositions(
        tx,
        rows.map((r) => r.booking),
      );
      return out.map((b, i) => ({ ...b, memberName: rows[i]?.memberName ?? "" }));
    });
  }

  @Post("bookings/:bookingId/cancel")
  @Roles("owner", "manager", "front_desk")
  @HttpCode(200)
  cancel(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.cancelBooking.params)) params: { bookingId: string },
  ): Promise<BookingOut> {
    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      const [row] = await tx.select().from(bookings).where(eq(bookings.id, params.bookingId));
      if (!row) throw new NotFoundException("Booking not found");
      await this.visibleSession(tx, tenant, row.sessionId, "Booking not found");
      return cancel(tx, row);
    });
  }

  private async visibleSession(
    tx: Tx,
    tenant: TenantContext,
    sessionId: string,
    notFound = "Session not found",
  ) {
    const [session] = await tx
      .select({ branchId: classSessions.branchId })
      .from(classSessions)
      .where(eq(classSessions.id, sessionId));
    if (!session || !canUseBranch(tenant, session.branchId)) throw new NotFoundException(notFound);
  }
}

@Controller("me/gyms/:orgId")
export class MyBookingsController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  @Get("sessions")
  async sessions(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodPipe(contracts.listMySessions.params)) params: { orgId: string },
    @Query(new ZodPipe(contracts.listMySessions.query))
    query: z.output<typeof routes.listMySessions.query>,
  ): Promise<z.output<typeof routes.listMySessions.response>> {
    const gym = await myMembership(this.db.db, auth.userId, params.orgId);
    const range = sessionRange(query);
    return withTenant(this.db.db, gym.orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(classSessions)
        .where(
          and(
            range,
            eq(classSessions.status, "scheduled"),
            eq(classSessions.kind, "class"),
            query.branchId ? eq(classSessions.branchId, query.branchId) : undefined,
          ),
        )
        .orderBy(asc(classSessions.startsAt));
      const mine = rows.length
        ? await tx
            .select()
            .from(bookings)
            .where(
              and(
                eq(bookings.memberId, gym.memberId),
                inArray(
                  bookings.sessionId,
                  rows.map((r) => r.id),
                ),
                inArray(bookings.status, [...LIVE]),
              ),
            )
        : [];
      const myBookings = new Map(
        (await withPositions(tx, mine)).map((b) => [b.sessionId, b] as const),
      );
      return (await sessionsWithPlaces(tx, rows)).map((s) => ({
        ...s,
        myBooking: myBookings.get(s.id) ?? null,
      }));
    });
  }

  @Post("sessions/:sessionId/bookings")
  @HttpCode(201)
  async book(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodPipe(contracts.bookMySession.params))
    params: { orgId: string; sessionId: string },
  ): Promise<BookingOut> {
    const gym = await myMembership(this.db.db, auth.userId, params.orgId);
    return withTenant(this.db.db, gym.orgId, (tx) =>
      book(tx, { sessionId: params.sessionId, memberId: gym.memberId }),
    );
  }

  @Get("bookings")
  async list(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodPipe(contracts.listMyBookings.params)) params: { orgId: string },
  ): Promise<z.output<typeof routes.listMyBookings.response>> {
    const gym = await myMembership(this.db.db, auth.userId, params.orgId);
    return withTenant(this.db.db, gym.orgId, async (tx) => {
      const rows = await tx
        .select({ booking: bookings, session: classSessions })
        .from(bookings)
        .innerJoin(classSessions, eq(classSessions.id, bookings.sessionId))
        .where(eq(bookings.memberId, gym.memberId))
        .orderBy(desc(classSessions.startsAt))
        .limit(HISTORY);
      const out = await withPositions(
        tx,
        rows.map((r) => r.booking),
      );
      const sessions = await sessionsWithPlaces(
        tx,
        rows.map((r) => r.session),
      );
      return out.flatMap((b, i) => {
        const session = sessions[i];
        return session ? [{ ...b, session }] : [];
      });
    });
  }

  @Post("bookings/:bookingId/cancel")
  @HttpCode(200)
  async cancel(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodPipe(contracts.cancelMyBooking.params))
    params: { orgId: string; bookingId: string },
  ): Promise<BookingOut> {
    const gym = await myMembership(this.db.db, auth.userId, params.orgId);
    return withTenant(this.db.db, gym.orgId, async (tx) => {
      const [row] = await tx
        .select()
        .from(bookings)
        .where(and(eq(bookings.id, params.bookingId), eq(bookings.memberId, gym.memberId)));
      if (!row) throw new NotFoundException("Booking not found");
      return cancel(tx, row);
    });
  }
}
