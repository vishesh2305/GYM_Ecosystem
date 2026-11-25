import type { routes } from "@gym/contracts";
import { withTenant, withUser, type DbHandle } from "@gym/db";
import { and, desc, eq, isNull, sql } from "@gym/db/orm";
import { members, notifications, pushDevices } from "@gym/db/schema";
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import type { z } from "zod";
import { CurrentAuth } from "../auth/auth.guard";
import type { AuthContext } from "../auth/auth.types";
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

@Controller("me/devices")
export class MyDevicesController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  @Post()
  @HttpCode(201)
  async register(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(contracts.registerDevice.body))
    body: z.output<typeof routes.registerDevice.body>,
  ): Promise<{ id: string }> {
    const result = await withUser(this.db.db, auth.userId, (tx) =>
      tx.execute<{ id: string }>(
        sql`select app.register_push_device(${body.token}, ${body.platform}) as id`,
      ),
    );
    return { id: result.rows[0]?.id ?? "" };
  }

  @Delete(":deviceId")
  @HttpCode(204)
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodPipe(contracts.removeDevice.params)) params: { deviceId: string },
  ): Promise<void> {
    await withUser(this.db.db, auth.userId, (tx) =>
      tx.delete(pushDevices).where(eq(pushDevices.id, params.deviceId)),
    );
  }
}

type NotificationOut = z.output<typeof routes.listMemberNotifications.response>[number];

@TenantScoped()
@Controller("orgs/:orgId/members/:memberId/notifications")
export class MemberNotificationsController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  /** For the front desk: "did they get the reminder?" */
  @Get()
  @Roles("owner", "manager", "front_desk")
  list(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.listMemberNotifications.params)) params: { memberId: string },
  ): Promise<NotificationOut[]> {
    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      const [member] = await tx
        .select({ homeBranchId: members.homeBranchId })
        .from(members)
        .where(and(eq(members.id, params.memberId), isNull(members.deletedAt)));
      if (!member || !canUseBranch(tenant, member.homeBranchId))
        throw new NotFoundException("Member not found");
      const rows = await tx
        .select()
        .from(notifications)
        .where(eq(notifications.memberId, params.memberId))
        .orderBy(desc(notifications.createdAt))
        .limit(100);
      return rows.map((n) => ({
        id: n.id,
        key: n.key,
        status: n.status,
        channel: n.channel,
        attempts: n.attempts,
        lastError: n.lastError,
        sendAfter: n.sendAfter.toISOString(),
        sentAt: n.sentAt?.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
      }));
    });
  }
}
