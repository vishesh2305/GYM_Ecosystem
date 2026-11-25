import { withSystem, withTenant, type Database, type Tx } from "@gym/db";
import { and, eq, gt, isNull } from "@gym/db/orm";
import { classes, classSessions, organisations, staffMembers } from "@gym/db/schema";
import { occurrences, todayIn, zonedTime } from "@gym/domain";
import { BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { appendEvent, defineEvent } from "../platform/events";

/** Sessions exist this many days ahead, so members can book up to two weeks in advance. */
export const HORIZON_DAYS = 14;

type GymClass = typeof classes.$inferSelect;
export type Session = typeof classSessions.$inferSelect;

/** Delivered by notifications (A14) to every member who had a place or was waiting. */
export const sessionCancelled = defineEvent(
  "class_session.cancelled",
  z.object({
    sessionId: z.uuid(),
    name: z.string(),
    startsAt: z.iso.datetime(),
    reason: z.string(),
    memberIds: z.array(z.uuid()),
  }),
);

/** Create the class's sessions for the coming HORIZON_DAYS that do not exist yet. Returns how many. */
export async function generateSessions(
  tx: Tx,
  cls: GymClass,
  timezone: string,
  now: Date = new Date(),
): Promise<number> {
  const rows = occurrences(cls, todayIn(timezone, now), HORIZON_DAYS)
    .map((date) => {
      const startsAt = zonedTime(date, cls.startTime, timezone);
      return {
        tenantId: cls.tenantId,
        branchId: cls.branchId,
        classId: cls.id,
        kind: "class" as const,
        name: cls.name,
        room: cls.room,
        instructorId: cls.instructorId,
        startsAt,
        endsAt: new Date(startsAt.getTime() + cls.durationMinutes * 60_000),
        capacity: cls.capacity,
        cancelWindowMinutes: cls.cancelWindowMinutes,
      };
    })
    .filter((row) => row.startsAt > now);
  if (!rows.length) return 0;
  const created = await tx
    .insert(classSessions)
    .values(rows)
    .onConflictDoNothing({ target: [classSessions.classId, classSessions.startsAt] })
    .returning({ id: classSessions.id });
  return created.length;
}

/** Hourly, per gym: keep every active class's sessions HORIZON_DAYS ahead. Idempotent. */
export async function runSessionGeneration(db: Database, now: Date = new Date()) {
  const orgs = await withSystem(db, (tx) =>
    tx
      .select({ id: organisations.id, timezone: organisations.timezone })
      .from(organisations)
      .where(isNull(organisations.deletedAt)),
  );
  let created = 0;
  for (const org of orgs) {
    await withTenant(db, org.id, async (tx) => {
      const active = await tx.select().from(classes).where(eq(classes.active, true));
      for (const cls of active) created += await generateSessions(tx, cls, org.timezone, now);
    });
  }
  return { created };
}

/** Cancel sessions that are still on, telling everyone who held or awaited a place. */
export async function cancelSessions(
  tx: Tx,
  sessions: readonly Session[],
  reason: string,
): Promise<Session[]> {
  const cancelled: Session[] = [];
  for (const session of sessions) {
    const [row] = await tx
      .update(classSessions)
      .set({ status: "cancelled", cancelReason: reason })
      .where(and(eq(classSessions.id, session.id), eq(classSessions.status, "scheduled")))
      .returning();
    if (!row) continue;
    const memberIds: string[] = [];
    await appendEvent(
      tx,
      sessionCancelled,
      {
        sessionId: row.id,
        name: row.name,
        startsAt: row.startsAt.toISOString(),
        reason,
        memberIds,
      },
      row.tenantId,
    );
    cancelled.push(row);
  }
  return cancelled;
}

/** Upcoming sessions of a class that have not been cancelled. */
export const upcomingSessions = (tx: Tx, classId: string, now: Date = new Date()) =>
  tx
    .select()
    .from(classSessions)
    .where(
      and(
        eq(classSessions.classId, classId),
        eq(classSessions.status, "scheduled"),
        gt(classSessions.startsAt, now),
      ),
    );

/** An instructor must be an active member of this gym's staff. */
export async function assertInstructor(tx: Tx, instructorId: string | null | undefined) {
  if (!instructorId) return;
  const [staff] = await tx
    .select({ id: staffMembers.id })
    .from(staffMembers)
    .where(and(eq(staffMembers.id, instructorId), eq(staffMembers.status, "active")));
  if (!staff) throw new BadRequestException("The instructor is not on this gym's staff");
}
