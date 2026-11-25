import type { routes } from "@gym/contracts";
import { withTenant, type DbHandle, type Tx } from "@gym/db";
import { eq } from "@gym/db/orm";
import { notificationPreferences } from "@gym/db/schema";
import { DEFAULT_QUIET_HOURS } from "@gym/domain";
import { Body, Controller, Get, Inject, Param, Patch } from "@nestjs/common";
import type { z } from "zod";
import { myMembership } from "../access/my-gyms";
import { CurrentAuth } from "../auth/auth.guard";
import type { AuthContext } from "../auth/auth.types";
import { contracts } from "../common/contracts";
import { compact } from "../common/compact";
import { ZodPipe } from "../common/zod.pipe";
import { DB } from "../tokens";

type Row = typeof notificationPreferences.$inferSelect;
export type Preferences = Pick<
  Row,
  "locale" | "disabledChannels" | "mutedCategories" | "quietStart" | "quietEnd"
>;
type PreferencesOut = z.output<typeof routes.getMyNotificationPreferences.response>;

/** A member's preferences, or the defaults when they never set any. */
export async function preferencesOf(tx: Tx, memberId: string): Promise<Preferences> {
  const [row] = await tx
    .select({
      locale: notificationPreferences.locale,
      disabledChannels: notificationPreferences.disabledChannels,
      mutedCategories: notificationPreferences.mutedCategories,
      quietStart: notificationPreferences.quietStart,
      quietEnd: notificationPreferences.quietEnd,
    })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.memberId, memberId));
  return (
    row ?? {
      locale: "en",
      disabledChannels: [],
      mutedCategories: [],
      quietStart: DEFAULT_QUIET_HOURS.start,
      quietEnd: DEFAULT_QUIET_HOURS.end,
    }
  );
}

const toOut = (p: Preferences): PreferencesOut => ({
  locale: p.locale,
  disabledChannels: p.disabledChannels,
  mutedCategories: p.mutedCategories,
  quietHours: { start: p.quietStart, end: p.quietEnd },
});

@Controller("me/gyms/:orgId/notification-preferences")
export class MyNotificationPreferencesController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  @Get()
  async get(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodPipe(contracts.getMyNotificationPreferences.params)) params: { orgId: string },
  ): Promise<PreferencesOut> {
    const gym = await myMembership(this.db.db, auth.userId, params.orgId);
    return withTenant(this.db.db, gym.orgId, async (tx) =>
      toOut(await preferencesOf(tx, gym.memberId)),
    );
  }

  @Patch()
  async update(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodPipe(contracts.updateMyNotificationPreferences.params)) params: { orgId: string },
    @Body(new ZodPipe(contracts.updateMyNotificationPreferences.body))
    body: z.output<typeof routes.updateMyNotificationPreferences.body>,
  ): Promise<PreferencesOut> {
    const gym = await myMembership(this.db.db, auth.userId, params.orgId);
    const changes = compact({
      locale: body.locale,
      disabledChannels: body.disabledChannels && [...new Set(body.disabledChannels)],
      mutedCategories: body.mutedCategories && [...new Set(body.mutedCategories)],
      quietStart: body.quietHours?.start,
      quietEnd: body.quietHours?.end,
    });
    return withTenant(this.db.db, gym.orgId, async (tx) => {
      const next = { ...(await preferencesOf(tx, gym.memberId)), ...changes };
      await tx
        .insert(notificationPreferences)
        .values({ ...next, memberId: gym.memberId, tenantId: gym.orgId })
        .onConflictDoUpdate({
          target: notificationPreferences.memberId,
          set: { ...next, updatedAt: new Date() },
        });
      return toOut(next);
    });
  }
}
