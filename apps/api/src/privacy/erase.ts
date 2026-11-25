import type { Tx } from "@gym/db";
import { and, eq, notInArray, or } from "@gym/db/orm";
import {
  auditLog,
  autopayMandates,
  leads,
  leadTasks,
  memberPasses,
  members,
  membershipFreezes,
  memberships,
  notificationPreferences,
  notifications,
  otpChallenges,
  staffInvites,
  users,
} from "@gym/db/schema";
import { anyOf } from "./export";

export const ERASED_NAME = "Erased member";

/**
 * Erases one person (DPDP Act 2023, right to erasure), following the registry in packages/db/src/personal-data.ts:
 * deletes their account (which cascades to sign-ins, consents, devices, jobs and training data), deletes messages,
 * passes and preferences, and anonymises their member records and enquiries in every gym. Records the law
 * requires (invoices, payments, memberships) stay, tied only to the anonymised member. Run inside withPrivacy.
 */
export async function erasePerson(tx: Tx, userId: string, now: Date = new Date()) {
  const [user] = await tx.select().from(users).where(eq(users.id, userId));
  if (!user) return { alreadyErased: true };
  const contacts = [user.phone, user.email];
  const memberIds = (
    await tx.select({ id: members.id }).from(members).where(eq(members.userId, userId))
  ).map((m) => m.id);
  const leadIds = (
    await tx
      .select({ id: leads.id })
      .from(leads)
      .where(
        or(
          anyOf(leads.memberId, memberIds),
          anyOf(leads.phone, contacts),
          anyOf(leads.email, contacts),
        ),
      )
  ).map((l) => l.id);
  const membershipIds = (
    await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(anyOf(memberships.memberId, memberIds))
  ).map((m) => m.id);

  const count = async (rows: Promise<unknown[]>) => (await rows).length;
  const summary = {
    notifications: await count(
      tx.delete(notifications).where(anyOf(notifications.memberId, memberIds)).returning(),
    ),
    notificationPreferences: await count(
      tx
        .delete(notificationPreferences)
        .where(anyOf(notificationPreferences.memberId, memberIds))
        .returning(),
    ),
    memberPasses: await count(
      tx.delete(memberPasses).where(anyOf(memberPasses.memberId, memberIds)).returning(),
    ),
    leadTasks: await count(
      tx.delete(leadTasks).where(anyOf(leadTasks.leadId, leadIds)).returning(),
    ),
    leads: await count(
      tx
        .update(leads)
        .set({ name: "Erased person", phone: null, email: null, interest: null, consentAt: null })
        .where(anyOf(leads.id, leadIds))
        .returning(),
    ),
    freezes: await count(
      tx
        .update(membershipFreezes)
        .set({ reason: null })
        .where(anyOf(membershipFreezes.membershipId, membershipIds))
        .returning(),
    ),
    mandatesCancelled: await count(
      tx
        .update(autopayMandates)
        .set({ status: "cancelled", cancelledAt: now })
        .where(
          and(
            anyOf(autopayMandates.memberId, memberIds),
            notInArray(autopayMandates.status, ["cancelled", "failed"]),
          ),
        )
        .returning(),
    ),
    members: await count(
      tx
        .update(members)
        .set({
          name: ERASED_NAME,
          phone: null,
          email: null,
          dateOfBirth: null,
          gender: null,
          emergencyContactName: null,
          emergencyContactPhone: null,
          notes: null,
          userId: null,
          deletedAt: now,
        })
        .where(anyOf(members.id, memberIds))
        .returning(),
    ),
    otpChallenges: await count(
      tx.delete(otpChallenges).where(anyOf(otpChallenges.destination, contacts)).returning(),
    ),
    staffInvites: await count(
      tx.delete(staffInvites).where(anyOf(staffInvites.destination, contacts)).returning(),
    ),
  };
  // Open enquiries of the erased person are closed, so nobody calls them.
  await tx
    .update(leads)
    .set({ stage: "lost", lostReason: "Erased at the person's request" })
    .where(and(anyOf(leads.id, leadIds), notInArray(leads.stage, ["won", "lost"])));
  await tx.delete(users).where(eq(users.id, userId));
  await tx.insert(auditLog).values({
    actorType: "system",
    action: "person.erased",
    entityType: "user",
    entityId: userId,
    data: summary,
  });
  return summary;
}
