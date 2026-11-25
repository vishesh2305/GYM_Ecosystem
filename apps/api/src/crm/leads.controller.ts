import type { routes } from "@gym/contracts";
import { withTenant, type DbHandle, type Tx } from "@gym/db";
import { and, asc, desc, eq, ilike, isNull, or } from "@gym/db/orm";
import { leads, leadTasks, members, staffMembers } from "@gym/db/schema";
import { normalizePhone, type CountryCode } from "@gym/domain";
import {
  BadRequestException,
  Body,
  ConflictException,
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
import type { ApiEnv } from "../env";
import { escapeLike } from "../membership/members.service";
import { recordAudit } from "../platform/audit";
import { visibleBranch } from "../scheduling/classes.controller";
import {
  canUseBranch,
  CurrentTenant,
  Roles,
  TenantScoped,
  type TenantContext,
} from "../tenancy/tenant.guard";
import { DB, ENV } from "../tokens";

type Lead = typeof leads.$inferSelect;
type Task = typeof leadTasks.$inferSelect;
type LeadOut = z.output<typeof routes.getLead.response>;
type TaskOut = z.output<typeof routes.createLeadTask.response>;

const DAY_MS = 86_400_000;

export const toLead = (l: Lead) => ({
  id: l.id,
  branchId: l.branchId,
  name: l.name,
  phone: l.phone,
  email: l.email,
  source: l.source,
  stage: l.stage,
  assignedTo: l.assignedTo,
  interest: l.interest,
  trialAt: l.trialAt?.toISOString() ?? null,
  lostReason: l.lostReason,
  memberId: l.memberId,
  createdAt: l.createdAt.toISOString(),
});

const toTask = (t: Task): TaskOut => ({
  id: t.id,
  leadId: t.leadId,
  title: t.title,
  dueAt: t.dueAt.toISOString(),
  assignedTo: t.assignedTo,
  doneAt: t.doneAt?.toISOString() ?? null,
});

const pgCode = (error: unknown) =>
  (error as { cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code;

/** Normalises a phone number to E.164, or 400. */
export function leadPhone(env: ApiEnv, raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const e164 = normalizePhone(raw, env.DEFAULT_PHONE_REGION as CountryCode);
  if (!e164) throw new BadRequestException("Phone is not a valid phone number");
  return e164;
}

/** Turns the "one open lead per phone" index into a 409. */
export async function uniqueLead<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (pgCode(error) === "23505")
      throw new ConflictException("An open lead with this phone number already exists");
    throw error;
  }
}

async function assertStaff(tx: Tx, staffId: string | null | undefined) {
  if (!staffId) return;
  const [staff] = await tx
    .select({ id: staffMembers.id })
    .from(staffMembers)
    .where(and(eq(staffMembers.id, staffId), eq(staffMembers.status, "active")));
  if (!staff) throw new BadRequestException("Assign the lead to someone who works here");
}

/** A lead at one of the caller's branches, or 404. */
async function findLead(tx: Tx, tenant: TenantContext, leadId: string): Promise<Lead> {
  const [row] = await tx.select().from(leads).where(eq(leads.id, leadId));
  if (!row || !canUseBranch(tenant, row.branchId)) throw new NotFoundException("Lead not found");
  return row;
}

@TenantScoped()
@Controller("orgs/:orgId")
export class LeadsController {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  @Post("leads")
  @Roles("owner", "manager", "front_desk")
  @HttpCode(201)
  create(
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(contracts.createLead.body)) body: z.output<typeof routes.createLead.body>,
  ) {
    const phone = leadPhone(this.env, body.phone);
    return uniqueLead(() =>
      withTenant(this.db.db, tenant.tenantId, async (tx) => {
        await visibleBranch(tx, tenant, body.branchId);
        await assertStaff(tx, body.assignedTo);
        const [row] = await tx
          .insert(leads)
          .values({
            ...body,
            phone,
            email: body.email?.toLowerCase(),
            tenantId: tenant.tenantId,
            assignedTo: body.assignedTo ?? tenant.staffId,
          })
          .returning();
        if (!row) throw new Error("lead insert returned nothing");
        await recordAudit(tx, {
          tenantId: tenant.tenantId,
          actorType: "staff",
          actorId: tenant.staffId,
          action: "lead.created",
          entityType: "lead",
          entityId: row.id,
          data: { source: row.source },
        });
        return toLead(row);
      }),
    );
  }

  @Get("leads")
  @Roles("owner", "manager", "front_desk")
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query(new ZodPipe(contracts.listLeads.query)) query: z.output<typeof routes.listLeads.query>,
  ) {
    const term = query.q ? `%${escapeLike(query.q)}%` : undefined;
    const rows = await withTenant(this.db.db, tenant.tenantId, (tx) =>
      tx
        .select()
        .from(leads)
        .where(
          and(
            query.stage ? eq(leads.stage, query.stage) : undefined,
            query.branchId ? eq(leads.branchId, query.branchId) : undefined,
            term ? or(ilike(leads.name, term), ilike(leads.phone, term)) : undefined,
          ),
        )
        .orderBy(desc(leads.createdAt))
        .limit(200),
    );
    return rows.filter((l) => canUseBranch(tenant, l.branchId)).map(toLead);
  }

  @Get("leads/:leadId")
  @Roles("owner", "manager", "front_desk")
  get(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.getLead.params)) params: { leadId: string },
  ): Promise<LeadOut> {
    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      const lead = await findLead(tx, tenant, params.leadId);
      const tasks = await tx
        .select()
        .from(leadTasks)
        .where(eq(leadTasks.leadId, lead.id))
        .orderBy(asc(leadTasks.dueAt));
      return { ...toLead(lead), tasks: tasks.map(toTask) };
    });
  }

  @Patch("leads/:leadId")
  @Roles("owner", "manager", "front_desk")
  update(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.updateLead.params)) params: { leadId: string },
    @Body(new ZodPipe(contracts.updateLead.body)) body: z.output<typeof routes.updateLead.body>,
  ) {
    return uniqueLead(() =>
      withTenant(this.db.db, tenant.tenantId, async (tx) => {
        const lead = await findLead(tx, tenant, params.leadId);
        if (lead.stage === "won") throw new ConflictException("This lead has already joined");
        await assertStaff(tx, body.assignedTo);
        const stage = body.stage ?? lead.stage;
        const lostReason = stage === "lost" ? (body.lostReason ?? lead.lostReason) : null;
        if (stage === "lost" && !lostReason)
          throw new BadRequestException("Say why the lead was lost");
        const [row] = await tx
          .update(leads)
          .set({
            ...compact({
              name: body.name,
              phone: leadPhone(this.env, body.phone),
              email: body.email?.toLowerCase(),
              interest: body.interest,
              assignedTo: body.assignedTo,
            }),
            stage,
            lostReason,
          })
          .where(eq(leads.id, lead.id))
          .returning();
        if (!row) throw new NotFoundException("Lead not found");
        return toLead(row);
      }),
    );
  }

  @Post("leads/:leadId/trial")
  @Roles("owner", "manager", "front_desk")
  @HttpCode(200)
  trial(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.bookLeadTrial.params)) params: { leadId: string },
    @Body(new ZodPipe(contracts.bookLeadTrial.body)) body: { startsAt: string },
  ) {
    const startsAt = new Date(body.startsAt);
    if (startsAt.getTime() < Date.now() - DAY_MS)
      throw new BadRequestException("A trial cannot be more than a day in the past");
    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      const lead = await findLead(tx, tenant, params.leadId);
      if (lead.stage === "won") throw new ConflictException("This lead has already joined");
      const [row] = await tx
        .update(leads)
        .set({ stage: "trial_booked", trialAt: startsAt, lostReason: null })
        .where(eq(leads.id, lead.id))
        .returning();
      await tx.insert(leadTasks).values({
        tenantId: tenant.tenantId,
        leadId: lead.id,
        title: `Follow up with ${lead.name} after their trial`,
        dueAt: new Date(startsAt.getTime() + DAY_MS),
        assignedTo: lead.assignedTo ?? tenant.staffId,
        createdBy: tenant.staffId,
      });
      if (!row) throw new NotFoundException("Lead not found");
      return toLead(row);
    });
  }

  /** Joins the lead to the gym: links the member with the same phone, or creates one. Idempotent. */
  @Post("leads/:leadId/convert")
  @Roles("owner", "manager", "front_desk")
  @HttpCode(200)
  convert(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.convertLead.params)) params: { leadId: string },
  ) {
    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      const lead = await findLead(tx, tenant, params.leadId);
      if (lead.stage === "won") return toLead(lead);
      const [existing] = lead.phone
        ? await tx
            .select({ id: members.id })
            .from(members)
            .where(and(eq(members.phone, lead.phone), isNull(members.deletedAt)))
        : [];
      const [created] = existing
        ? [existing]
        : await tx
            .insert(members)
            .values({
              tenantId: tenant.tenantId,
              name: lead.name,
              phone: lead.phone,
              email: lead.email,
              homeBranchId: lead.branchId,
            })
            .returning({ id: members.id });
      if (!created) throw new Error("member insert returned nothing");
      const [row] = await tx
        .update(leads)
        .set({ stage: "won", memberId: created.id, lostReason: null })
        .where(eq(leads.id, lead.id))
        .returning();
      if (!row) throw new NotFoundException("Lead not found");
      await recordAudit(tx, {
        tenantId: tenant.tenantId,
        actorType: "staff",
        actorId: tenant.staffId,
        action: "lead.converted",
        entityType: "lead",
        entityId: lead.id,
        data: { memberId: created.id, linkedExisting: Boolean(existing) },
      });
      return toLead(row);
    });
  }

  @Post("leads/:leadId/tasks")
  @Roles("owner", "manager", "front_desk")
  @HttpCode(201)
  addTask(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.createLeadTask.params)) params: { leadId: string },
    @Body(new ZodPipe(contracts.createLeadTask.body))
    body: z.output<typeof routes.createLeadTask.body>,
  ): Promise<TaskOut> {
    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      const lead = await findLead(tx, tenant, params.leadId);
      await assertStaff(tx, body.assignedTo);
      const [row] = await tx
        .insert(leadTasks)
        .values({
          tenantId: tenant.tenantId,
          leadId: lead.id,
          title: body.title,
          dueAt: new Date(body.dueAt),
          assignedTo: body.assignedTo ?? lead.assignedTo ?? tenant.staffId,
          createdBy: tenant.staffId,
        })
        .returning();
      if (!row) throw new Error("task insert returned nothing");
      return toTask(row);
    });
  }

  @Get("tasks")
  @Roles("owner", "manager", "front_desk")
  async tasks(
    @CurrentTenant() tenant: TenantContext,
    @Query(new ZodPipe(contracts.listLeadTasks.query))
    query: z.output<typeof routes.listLeadTasks.query>,
  ) {
    const rows = await withTenant(this.db.db, tenant.tenantId, (tx) =>
      tx
        .select({ task: leadTasks, leadName: leads.name, branchId: leads.branchId })
        .from(leadTasks)
        .innerJoin(leads, eq(leads.id, leadTasks.leadId))
        .where(
          and(
            isNull(leadTasks.doneAt),
            query.mine ? eq(leadTasks.assignedTo, tenant.staffId) : undefined,
          ),
        )
        .orderBy(asc(leadTasks.dueAt))
        .limit(200),
    );
    return rows
      .filter((r) => canUseBranch(tenant, r.branchId))
      .map((r) => ({ ...toTask(r.task), leadName: r.leadName }));
  }

  @Post("tasks/:taskId/complete")
  @Roles("owner", "manager", "front_desk")
  @HttpCode(200)
  complete(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.completeLeadTask.params)) params: { taskId: string },
  ): Promise<TaskOut> {
    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      const [found] = await tx
        .select({ task: leadTasks, branchId: leads.branchId })
        .from(leadTasks)
        .innerJoin(leads, eq(leads.id, leadTasks.leadId))
        .where(eq(leadTasks.id, params.taskId));
      if (!found || !canUseBranch(tenant, found.branchId))
        throw new NotFoundException("Task not found");
      if (found.task.doneAt) return toTask(found.task);
      const [row] = await tx
        .update(leadTasks)
        .set({ doneAt: new Date() })
        .where(eq(leadTasks.id, found.task.id))
        .returning();
      return toTask(row ?? found.task);
    });
  }
}
