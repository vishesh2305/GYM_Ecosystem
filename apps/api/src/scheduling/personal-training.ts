import type { routes } from "@gym/contracts";
import { withTenant, type DbHandle } from "@gym/db";
import { and, eq, gt, lt, sql } from "@gym/db/orm";
import { classSessions } from "@gym/db/schema";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  Param,
  Post,
} from "@nestjs/common";
import type { z } from "zod";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import { recordAudit } from "../platform/audit";
import { CurrentTenant, Roles, TenantScoped, type TenantContext } from "../tenancy/tenant.guard";
import { DB } from "../tokens";
import { book } from "./bookings";
import { visibleBranch } from "./classes.controller";
import { assertInstructor, toSession } from "./timetable";

type Out = z.output<typeof routes.bookPersonalTraining.response>;

@TenantScoped()
@Controller("orgs/:orgId/branches/:branchId/pt-sessions")
export class PersonalTrainingController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  /**
   * A one-place session with the trainer, booked for the member under the usual membership rules. Trainers may
   * book their own sessions only. A per-trainer lock stops two overlapping bookings made at the same moment.
   */
  @Post()
  @Roles("owner", "manager", "front_desk", "trainer")
  @HttpCode(201)
  create(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.bookPersonalTraining.params)) params: { branchId: string },
    @Body(new ZodPipe(contracts.bookPersonalTraining.body))
    body: z.output<typeof routes.bookPersonalTraining.body>,
  ): Promise<Out> {
    if (tenant.role === "trainer" && body.trainerId !== tenant.staffId)
      throw new ForbiddenException("Trainers can book only their own sessions");
    const startsAt = new Date(body.startsAt);
    const endsAt = new Date(startsAt.getTime() + body.durationMinutes * 60_000);
    if (startsAt <= new Date()) throw new BadRequestException("Choose a time in the future");
    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      await visibleBranch(tx, tenant, params.branchId);
      await assertInstructor(tx, body.trainerId);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${body.trainerId}))`);
      const [clash] = await tx
        .select({ id: classSessions.id })
        .from(classSessions)
        .where(
          and(
            eq(classSessions.instructorId, body.trainerId),
            eq(classSessions.status, "scheduled"),
            lt(classSessions.startsAt, endsAt),
            gt(classSessions.endsAt, startsAt),
          ),
        );
      if (clash) throw new ConflictException("The trainer already has a session at that time");
      const [session] = await tx
        .insert(classSessions)
        .values({
          tenantId: tenant.tenantId,
          branchId: params.branchId,
          kind: "pt",
          name: body.name,
          instructorId: body.trainerId,
          startsAt,
          endsAt,
          capacity: 1,
          cancelWindowMinutes: body.cancelWindowMinutes,
        })
        .returning();
      if (!session) throw new Error("session insert returned nothing");
      const booking = await book(tx, {
        sessionId: session.id,
        memberId: body.memberId,
        staffId: tenant.staffId,
      });
      await recordAudit(tx, {
        tenantId: tenant.tenantId,
        actorType: "staff",
        actorId: tenant.staffId,
        action: "pt_session.booked",
        entityType: "class_session",
        entityId: session.id,
        data: { memberId: body.memberId, trainerId: body.trainerId },
      });
      return { session: toSession(session, { booked: 1, waitlisted: 0 }), booking };
    });
  }
}
