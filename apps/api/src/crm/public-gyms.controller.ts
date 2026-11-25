import type { routes } from "@gym/contracts";
import { withTenant, withUser, type DbHandle, type Tx } from "@gym/db";
import { and, asc, eq, gt, isNull, lt, notInArray, sql } from "@gym/db/orm";
import { branches, classSessions, leads, organisations, plans } from "@gym/db/schema";
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { RouteConfig } from "@nestjs/platform-fastify";
import type { z } from "zod";
import { Public } from "../auth/auth.guard";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import type { ApiEnv } from "../env";
import { placesTaken } from "../scheduling/bookings";
import { DB, ENV } from "../tokens";
import { leadPhone } from "./leads.controller";

type Out<K extends keyof typeof routes> = z.output<(typeof routes)[K]["response"]>;

/** Browsers and the CDN may keep public pages for a few minutes. */
const CACHE = "public, max-age=60, s-maxage=300";
const DAY_MS = 86_400_000;
/** Public requests have no signed-in person; app.published_gym needs only the app_user role. */
const NOBODY = "00000000-0000-0000-0000-000000000000";

/**
 * The id of a published gym, found with app.published_gym (a narrow SECURITY DEFINER lookup), or 404. Unpublished
 * and unknown gyms look the same.
 */
async function publishedGym(db: DbHandle["db"], slug: string): Promise<string> {
  const result = await withUser(db, NOBODY, (tx) =>
    tx.execute<{ id: string | null }>(sql`select app.published_gym(${slug}) as id`),
  );
  const id = result.rows[0]?.id;
  if (!id) throw new NotFoundException("Gym not found");
  return id;
}

async function liveBranch(tx: Tx, branchId: string) {
  const [branch] = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.id, branchId), isNull(branches.deletedAt)));
  if (!branch) throw new NotFoundException("Branch not found");
}

/** A gym's public web page data and its enquiry form. Explicit field lists: nothing private can slip out. */
@Public()
@Controller("public/gyms/:slug")
export class PublicGymsController {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  @Get()
  @Header("cache-control", CACHE)
  async page(
    @Param(new ZodPipe(contracts.getPublicGym.params)) params: { slug: string },
  ): Promise<Out<"getPublicGym">> {
    const gymId = await publishedGym(this.db.db, params.slug);
    return withTenant(this.db.db, gymId, async (tx) => {
      const [org] = await tx
        .select({
          name: organisations.name,
          slug: organisations.slug,
          about: organisations.about,
          timezone: organisations.timezone,
        })
        .from(organisations);
      if (!org?.slug) throw new NotFoundException("Gym not found");
      const branchRows = await tx
        .select({
          id: branches.id,
          name: branches.name,
          addressLine: branches.addressLine,
          city: branches.city,
          state: branches.state,
          postalCode: branches.postalCode,
          phone: branches.phone,
        })
        .from(branches)
        .where(isNull(branches.deletedAt))
        .orderBy(asc(branches.name));
      const planRows = await tx
        .select({
          id: plans.id,
          name: plans.name,
          description: plans.description,
          durationUnit: plans.durationUnit,
          durationCount: plans.durationCount,
          pricePaise: plans.pricePaise,
          joiningFeePaise: plans.joiningFeePaise,
          gstRateBps: plans.gstRateBps,
          isTrial: plans.isTrial,
          branchIds: plans.branchIds,
        })
        .from(plans)
        .where(eq(plans.active, true))
        .orderBy(asc(plans.pricePaise));
      return { ...org, slug: org.slug, branches: branchRows, plans: planRows };
    });
  }

  @Get("schedule")
  @Header("cache-control", CACHE)
  async schedule(
    @Param(new ZodPipe(contracts.getPublicSchedule.params)) params: { slug: string },
    @Query(new ZodPipe(contracts.getPublicSchedule.query))
    query: z.output<typeof routes.getPublicSchedule.query>,
  ): Promise<Out<"getPublicSchedule">> {
    const gymId = await publishedGym(this.db.db, params.slug);
    const now = new Date();
    const until = new Date(now.getTime() + (query.days ?? 7) * DAY_MS);
    return withTenant(this.db.db, gymId, async (tx) => {
      const sessions = await tx
        .select()
        .from(classSessions)
        .where(
          and(
            eq(classSessions.kind, "class"),
            eq(classSessions.status, "scheduled"),
            gt(classSessions.startsAt, now),
            lt(classSessions.startsAt, until),
            query.branchId ? eq(classSessions.branchId, query.branchId) : undefined,
          ),
        )
        .orderBy(asc(classSessions.startsAt));
      const taken = await placesTaken(
        tx,
        sessions.map((s) => s.id),
      );
      return sessions.map((s) => ({
        id: s.id,
        branchId: s.branchId,
        name: s.name,
        room: s.room,
        startsAt: s.startsAt.toISOString(),
        endsAt: s.endsAt.toISOString(),
        placesLeft: Math.max(0, s.capacity - (taken.get(s.id)?.booked ?? 0)),
      }));
    });
  }

  /**
   * Always answers "received", whether the person was new or already enquiring, so the form reveals nothing
   * about who has been in touch. A repeated enquiry updates the open lead instead of adding another.
   */
  @Post("enquiries")
  @HttpCode(202)
  @RouteConfig({ rateLimit: { max: 5, timeWindow: "1 minute" } })
  async enquire(
    @Param(new ZodPipe(contracts.createEnquiry.params)) params: { slug: string },
    @Body(new ZodPipe(contracts.createEnquiry.body))
    body: z.output<typeof routes.createEnquiry.body>,
  ): Promise<Out<"createEnquiry">> {
    const gymId = await publishedGym(this.db.db, params.slug);
    const phone = leadPhone(this.env, body.phone) ?? "";
    const now = new Date();
    await withTenant(this.db.db, gymId, async (tx) => {
      await liveBranch(tx, body.branchId);
      const updated = await tx
        .update(leads)
        .set({ consentAt: now, ...(body.interest && { interest: body.interest }) })
        .where(and(eq(leads.phone, phone), notInArray(leads.stage, ["won", "lost"])))
        .returning({ id: leads.id });
      if (updated.length) return;
      await tx
        .insert(leads)
        .values({
          tenantId: gymId,
          branchId: body.branchId,
          name: body.name,
          phone,
          email: body.email?.toLowerCase(),
          interest: body.interest,
          source: "website",
          consentAt: now,
        })
        // Two submissions at the same moment: the first one wins, the other is the same enquiry.
        .onConflictDoNothing();
    });
    return { received: true };
  }
}
