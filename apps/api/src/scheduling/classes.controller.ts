import type { routes } from "@gym/contracts";
import { withTenant, type DbHandle, type Tx } from "@gym/db";
import { and, asc, eq, isNull } from "@gym/db/orm";
import { branches, classes, classSessions } from "@gym/db/schema";
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import type { z } from "zod";
import { compact } from "../common/compact";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import { orgTimezone, orgToday } from "../membership/memberships.service";
import { recordAudit } from "../platform/audit";
import {
  canUseBranch,
  CurrentTenant,
  Roles,
  TenantScoped,
  type TenantContext,
} from "../tenancy/tenant.guard";
import { DB } from "../tokens";
import {
  assertInstructor,
  cancelSessions,
  generateSessions,
  sessionRange,
  toSession,
  upcomingSessions,
  type SessionOut,
} from "./timetable";
import { refillSession, sessionsWithPlaces } from "./bookings";

type GymClass = typeof classes.$inferSelect;
type ClassOut = z.output<typeof routes.listClasses.response>[number];

const toClass = (c: GymClass): ClassOut => ({
  id: c.id,
  branchId: c.branchId,
  name: c.name,
  description: c.description,
  room: c.room,
  instructorId: c.instructorId,
  capacity: c.capacity,
  durationMinutes: c.durationMinutes,
  weekdays: c.weekdays,
  startTime: c.startTime,
  startsOn: c.startsOn,
  endsOn: c.endsOn,
  cancelWindowMinutes: c.cancelWindowMinutes,
  active: c.active,
});

/** The branch in the URL must exist and be one the caller works at; otherwise it does not exist for them. */
export async function visibleBranch(tx: Tx, tenant: TenantContext, branchId: string) {
  const [branch] = canUseBranch(tenant, branchId)
    ? await tx
        .select({ id: branches.id })
        .from(branches)
        .where(and(eq(branches.id, branchId), isNull(branches.deletedAt)))
    : [];
  if (!branch) throw new NotFoundException("Branch not found");
}

@TenantScoped()
@Controller("orgs/:orgId")
export class ClassesController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  @Post("branches/:branchId/classes")
  @Roles("owner", "manager")
  @HttpCode(201)
  create(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.createClass.params)) params: { branchId: string },
    @Body(new ZodPipe(contracts.createClass.body)) body: z.output<typeof routes.createClass.body>,
  ): Promise<ClassOut> {
    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      await visibleBranch(tx, tenant, params.branchId);
      await assertInstructor(tx, body.instructorId);
      const startsOn = body.startsOn ?? (await orgToday(tx));
      if (body.endsOn && body.endsOn < startsOn)
        throw new BadRequestException("The class cannot end before it starts");
      const [row] = await tx
        .insert(classes)
        .values({
          ...body,
          weekdays: [...new Set(body.weekdays)].sort(),
          startsOn,
          tenantId: tenant.tenantId,
          branchId: params.branchId,
          createdBy: tenant.staffId,
        })
        .returning();
      if (!row) throw new Error("class insert returned nothing");
      await generateSessions(tx, row, await orgTimezone(tx));
      await recordAudit(tx, {
        tenantId: tenant.tenantId,
        actorType: "staff",
        actorId: tenant.staffId,
        action: "class.created",
        entityType: "class",
        entityId: row.id,
        data: { name: row.name, weekdays: row.weekdays, startTime: row.startTime },
      });
      return toClass(row);
    });
  }

  @Get("classes")
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query(new ZodPipe(contracts.listClasses.query))
    query: z.output<typeof routes.listClasses.query>,
  ): Promise<ClassOut[]> {
    const rows = await withTenant(this.db.db, tenant.tenantId, (tx) =>
      tx
        .select()
        .from(classes)
        .where(query.includeArchived ? undefined : eq(classes.active, true))
        .orderBy(asc(classes.startTime), asc(classes.name)),
    );
    return rows.filter((c) => canUseBranch(tenant, c.branchId)).map(toClass);
  }

  @Patch("classes/:classId")
  @Roles("owner", "manager")
  update(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.updateClass.params)) params: { classId: string },
    @Body(new ZodPipe(contracts.updateClass.body)) body: z.output<typeof routes.updateClass.body>,
  ): Promise<ClassOut> {
    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      await this.find(tx, tenant, params.classId);
      await assertInstructor(tx, body.instructorId);
      const changes = compact(body);
      const [row] = await tx
        .update(classes)
        .set(changes)
        .where(eq(classes.id, params.classId))
        .returning();
      if (!row) throw new NotFoundException("Class not found");
      const sessionChanges = compact({
        name: body.name,
        room: body.room,
        instructorId: body.instructorId,
        capacity: body.capacity,
        cancelWindowMinutes: body.cancelWindowMinutes,
      });
      if (Object.keys(sessionChanges).length) {
        for (const session of await upcomingSessions(tx, row.id)) {
          await tx
            .update(classSessions)
            .set(sessionChanges)
            .where(eq(classSessions.id, session.id));
          if (body.capacity !== undefined) await refillSession(tx, session.id);
        }
      }
      await recordAudit(tx, {
        tenantId: tenant.tenantId,
        actorType: "staff",
        actorId: tenant.staffId,
        action: "class.updated",
        entityType: "class",
        entityId: row.id,
        data: changes,
      });
      return toClass(row);
    });
  }

  @Post("classes/:classId/archive")
  @Roles("owner", "manager")
  @HttpCode(200)
  archive(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.archiveClass.params)) params: { classId: string },
  ): Promise<ClassOut> {
    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      await this.find(tx, tenant, params.classId);
      const [row] = await tx
        .update(classes)
        .set({ active: false })
        .where(eq(classes.id, params.classId))
        .returning();
      if (!row) throw new NotFoundException("Class not found");
      await cancelSessions(
        tx,
        await upcomingSessions(tx, row.id),
        "This class has been taken off the timetable",
      );
      await recordAudit(tx, {
        tenantId: tenant.tenantId,
        actorType: "staff",
        actorId: tenant.staffId,
        action: "class.archived",
        entityType: "class",
        entityId: row.id,
        data: {},
      });
      return toClass(row);
    });
  }

  private async find(tx: Tx, tenant: TenantContext, classId: string): Promise<GymClass> {
    const [row] = await tx.select().from(classes).where(eq(classes.id, classId));
    if (!row || !canUseBranch(tenant, row.branchId)) throw new NotFoundException("Class not found");
    return row;
  }
}

@TenantScoped()
@Controller("orgs/:orgId/sessions")
export class ClassSessionsController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  @Get()
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query(new ZodPipe(contracts.listClassSessions.query))
    query: z.output<typeof routes.listClassSessions.query>,
  ): Promise<SessionOut[]> {
    const range = sessionRange(query);
    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(classSessions)
        .where(
          and(
            range,
            query.branchId ? eq(classSessions.branchId, query.branchId) : undefined,
            query.instructorId ? eq(classSessions.instructorId, query.instructorId) : undefined,
          ),
        )
        .orderBy(asc(classSessions.startsAt));
      return sessionsWithPlaces(
        tx,
        rows.filter((s) => canUseBranch(tenant, s.branchId)),
      );
    });
  }

  @Post(":sessionId/cancel")
  @Roles("owner", "manager")
  @HttpCode(200)
  cancel(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.cancelClassSession.params)) params: { sessionId: string },
    @Body(new ZodPipe(contracts.cancelClassSession.body)) body: { reason: string },
  ): Promise<SessionOut> {
    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      const [session] = await tx
        .select()
        .from(classSessions)
        .where(eq(classSessions.id, params.sessionId));
      if (!session || !canUseBranch(tenant, session.branchId))
        throw new NotFoundException("Session not found");
      if (session.status === "cancelled") return toSession(session);
      if (session.endsAt <= new Date())
        throw new BadRequestException("This session has already taken place");
      const [cancelled] = await cancelSessions(tx, [session], body.reason);
      await recordAudit(tx, {
        tenantId: tenant.tenantId,
        actorType: "staff",
        actorId: tenant.staffId,
        action: "class_session.cancelled",
        entityType: "class_session",
        entityId: session.id,
        data: { reason: body.reason },
      });
      return toSession(cancelled ?? session);
    });
  }
}
