import type { routes } from "@gym/contracts";
import { withTenant, type DbHandle, type Tx } from "@gym/db";
import { and, count, eq, gt, inArray, isNull, ne } from "@gym/db/orm";
import { organisations, staffInvites, staffMembers, users, type StaffRole } from "@gym/db/schema";
import { normalizePhone, type CountryCode } from "@gym/domain";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { validate } from "uuid";
import type { z } from "zod";
import type { EmailSender, SmsSender } from "../auth/senders";
import type { ApiEnv } from "../env";
import { recordAudit } from "../platform/audit";
import { appendEvent } from "../platform/events";
import { DB, EMAIL_SENDER, ENV, SMS_SENDER } from "../tokens";
import { staffJoined } from "./events";
import { toOrganisation, type OrganisationOut } from "./mappers";
import { assertBranchesExist, assertWithinMyBranches, overlapsMyBranches } from "./branch-checks";
import { isBranchScoped, type TenantContext } from "./tenant.guard";

type InviteIn = z.output<typeof routes.inviteStaff.body>;
type InviteOut = z.output<typeof routes.inviteStaff.response>;
type StaffOut = z.output<typeof routes.updateStaff.response>;
type StaffUpdate = z.output<typeof routes.updateStaff.body>;

const INVITE_DAYS = 7;
const ROLE_NAMES: Record<StaffRole, string> = {
  owner: "an owner",
  manager: "a manager",
  front_desk: "front desk staff",
  trainer: "a trainer",
};
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Staff invites and role management. A gym always keeps at least one active owner. */
@Injectable()
export class StaffService {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
  ) {}

  async invite(tenant: TenantContext, body: InviteIn): Promise<InviteOut> {
    if (tenant.role === "manager" && (body.role === "owner" || body.role === "manager")) {
      throw new ForbiddenException("Managers can invite front desk staff and trainers only");
    }
    assertWithinMyBranches(
      tenant,
      body.branchIds,
      "You can only invite people to your own branches",
    );
    const destination =
      body.channel === "sms"
        ? normalizePhone(body.phone, this.env.DEFAULT_PHONE_REGION as CountryCode)
        : body.email.trim().toLowerCase();
    if (!destination) throw new BadRequestException("Enter a valid mobile number");

    const [existingUser] = await this.db.db
      .select({ id: users.id })
      .from(users)
      .where(body.channel === "sms" ? eq(users.phone, destination) : eq(users.email, destination));

    const token = `${tenant.tenantId}.${randomBytes(32).toString("base64url")}`;
    const { invite, orgName } = await withTenant(this.db.db, tenant.tenantId, async (tx) => {
      await assertBranchesExist(tx, body.branchIds);
      if (existingUser) {
        const [already] = await tx
          .select({ id: staffMembers.id })
          .from(staffMembers)
          .where(and(eq(staffMembers.userId, existingUser.id), eq(staffMembers.status, "active")));
        if (already) throw new ConflictException("This person already works here");
      }
      const [org] = await tx.select({ name: organisations.name }).from(organisations);
      const [row] = await tx
        .insert(staffInvites)
        .values({
          tenantId: tenant.tenantId,
          role: body.role,
          branchIds: body.branchIds,
          channel: body.channel,
          destination,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000),
          invitedBy: tenant.staffId,
        })
        .returning();
      if (!row) throw new Error("invite insert returned nothing");
      await recordAudit(tx, {
        tenantId: tenant.tenantId,
        actorType: "staff",
        actorId: tenant.staffId,
        action: "staff.invited",
        entityType: "staff_invite",
        entityId: row.id,
        data: { role: body.role, channel: body.channel },
      });
      return { invite: row, orgName: org?.name ?? "a gym" };
    });

    const text =
      `You have been invited to join ${orgName} as ${ROLE_NAMES[body.role]} on Gym Platform. ` +
      `Accept within ${INVITE_DAYS} days: ${this.env.APP_URL}/invite/${token}`;
    try {
      if (body.channel === "sms") await this.sms.send(destination, text);
      else
        await this.email.send({
          to: destination,
          subject: `Join ${orgName} on Gym Platform`,
          text,
        });
    } catch {
      throw new ServiceUnavailableException(
        "The invite was saved but could not be sent. Please try again.",
      );
    }
    return toInvite(invite);
  }

  async pendingInvites(tenant: TenantContext): Promise<InviteOut[]> {
    const rows = await withTenant(this.db.db, tenant.tenantId, (tx) =>
      tx
        .select()
        .from(staffInvites)
        .where(
          and(
            isNull(staffInvites.acceptedAt),
            isNull(staffInvites.revokedAt),
            gt(staffInvites.expiresAt, new Date()),
          ),
        ),
    );
    return rows.map(toInvite);
  }

  async revokeInvite(tenant: TenantContext, inviteId: string): Promise<void> {
    await withTenant(this.db.db, tenant.tenantId, async (tx) => {
      const [row] = await tx
        .update(staffInvites)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(staffInvites.id, inviteId),
            isNull(staffInvites.acceptedAt),
            isNull(staffInvites.revokedAt),
          ),
        )
        .returning({ id: staffInvites.id });
      if (!row) throw new NotFoundException("Invite not found");
      await recordAudit(tx, {
        tenantId: tenant.tenantId,
        actorType: "staff",
        actorId: tenant.staffId,
        action: "staff.invite_revoked",
        entityType: "staff_invite",
        entityId: inviteId,
      });
    });
  }

  /** The invite must have been sent to a phone or email this person has proven. */
  async accept(userId: string, token: string): Promise<OrganisationOut> {
    const notFound = new NotFoundException("Invite not found");
    const [orgId, secret] = token.split(".");
    if (!orgId || !secret || !validate(orgId)) throw notFound;
    const [user] = await this.db.db.select().from(users).where(eq(users.id, userId));
    if (!user) throw notFound;

    return withTenant(this.db.db, orgId, async (tx) => {
      const [invite] = await tx
        .select()
        .from(staffInvites)
        .where(eq(staffInvites.tokenHash, hashToken(token)));
      if (!invite) throw notFound;
      if (invite.acceptedAt || invite.revokedAt)
        throw new BadRequestException("This invite has already been used or cancelled");
      if (invite.expiresAt.getTime() <= Date.now())
        throw new BadRequestException("This invite has expired. Ask for a new one.");
      const proven =
        invite.channel === "sms"
          ? user.phone === invite.destination && user.phoneVerifiedAt !== null
          : user.email === invite.destination && user.emailVerifiedAt !== null;
      if (!proven)
        throw new ForbiddenException("This invite was sent to a different phone number or email");

      const claimed = await tx
        .update(staffInvites)
        .set({ acceptedAt: new Date(), acceptedBy: userId })
        .where(and(eq(staffInvites.id, invite.id), isNull(staffInvites.acceptedAt)))
        .returning({ id: staffInvites.id });
      if (!claimed.length)
        throw new BadRequestException("This invite has already been used or cancelled");

      await tx
        .insert(staffMembers)
        .values({
          tenantId: orgId,
          userId,
          role: invite.role,
          branchIds: invite.branchIds,
          invitedBy: invite.invitedBy,
        })
        .onConflictDoUpdate({
          target: [staffMembers.tenantId, staffMembers.userId],
          set: {
            role: invite.role,
            branchIds: invite.branchIds,
            status: "active",
            invitedBy: invite.invitedBy,
          },
        });
      await appendEvent(
        tx,
        staffJoined,
        { organisationId: orgId, userId, role: invite.role },
        orgId,
      );
      await recordAudit(tx, {
        tenantId: orgId,
        actorType: "staff",
        actorId: userId,
        action: "staff.joined",
        entityType: "staff_invite",
        entityId: invite.id,
        data: { role: invite.role },
      });
      const [org] = await tx.select().from(organisations);
      if (!org) throw notFound;
      return toOrganisation(org, invite.role);
    });
  }

  async list(tenant: TenantContext): Promise<StaffOut[]> {
    const all = await withTenant(this.db.db, tenant.tenantId, (tx) =>
      tx.select().from(staffMembers),
    );
    // Branch-scoped staff see colleagues sharing a branch, plus people who work at every branch.
    const rows = isBranchScoped(tenant)
      ? all.filter((r) => overlapsMyBranches(tenant, r.branchIds))
      : all;
    // Profiles live outside the tenant; the ids come from RLS-filtered rows, so only this gym's staff are read.
    const profiles = rows.length
      ? await this.db.db
          .select()
          .from(users)
          .where(
            inArray(
              users.id,
              rows.map((r) => r.userId),
            ),
          )
      : [];
    const byId = new Map(profiles.map((p) => [p.id, p]));
    return rows.map((r) => toStaff(r, byId.get(r.userId)));
  }

  async update(tenant: TenantContext, staffId: string, body: StaffUpdate): Promise<StaffOut> {
    const row = await withTenant(this.db.db, tenant.tenantId, async (tx) => {
      const target = await this.findStaff(tx, staffId);
      const losesOwner =
        target.role === "owner" &&
        ((body.role && body.role !== "owner") || body.status === "suspended");
      if (losesOwner) await this.assertAnotherOwner(tx, staffId);
      if (body.branchIds) await assertBranchesExist(tx, body.branchIds);
      const [updated] = await tx
        .update(staffMembers)
        .set(body)
        .where(eq(staffMembers.id, staffId))
        .returning();
      if (!updated) throw new NotFoundException("Staff member not found");
      await recordAudit(tx, {
        tenantId: tenant.tenantId,
        actorType: "staff",
        actorId: tenant.staffId,
        action: "staff.updated",
        entityType: "staff_member",
        entityId: staffId,
        data: body,
      });
      return updated;
    });
    const [profile] = await this.db.db.select().from(users).where(eq(users.id, row.userId));
    return toStaff(row, profile);
  }

  async remove(tenant: TenantContext, staffId: string): Promise<void> {
    await withTenant(this.db.db, tenant.tenantId, async (tx) => {
      const target = await this.findStaff(tx, staffId);
      if (target.role === "owner") await this.assertAnotherOwner(tx, staffId);
      await tx.delete(staffMembers).where(eq(staffMembers.id, staffId));
      await recordAudit(tx, {
        tenantId: tenant.tenantId,
        actorType: "staff",
        actorId: tenant.staffId,
        action: "staff.removed",
        entityType: "staff_member",
        entityId: staffId,
        data: { role: target.role },
      });
    });
  }

  private async findStaff(tx: Tx, staffId: string) {
    const [row] = await tx.select().from(staffMembers).where(eq(staffMembers.id, staffId));
    if (!row) throw new NotFoundException("Staff member not found");
    return row;
  }

  private async assertAnotherOwner(tx: Tx, exceptStaffId: string): Promise<void> {
    const [others] = await tx
      .select({ n: count() })
      .from(staffMembers)
      .where(
        and(
          eq(staffMembers.role, "owner"),
          eq(staffMembers.status, "active"),
          ne(staffMembers.id, exceptStaffId),
        ),
      );
    if (!others?.n) throw new ConflictException("A gym must always keep at least one active owner");
  }
}

function toInvite(row: typeof staffInvites.$inferSelect): InviteOut {
  return {
    id: row.id,
    role: row.role,
    branchIds: row.branchIds,
    channel: row.channel,
    destination: row.destination,
    expiresAt: row.expiresAt.toISOString(),
  };
}

function toStaff(
  row: typeof staffMembers.$inferSelect,
  profile?: typeof users.$inferSelect,
): StaffOut {
  return {
    id: row.id,
    userId: row.userId,
    name: profile?.name ?? null,
    phone: profile?.phone ?? null,
    email: profile?.email ?? null,
    role: row.role,
    branchIds: row.branchIds,
    status: row.status,
    joinedAt: row.createdAt.toISOString(),
  };
}
