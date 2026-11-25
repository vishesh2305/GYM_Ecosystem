import type { Tx } from "@gym/db";
import { eq, inArray, or, sql, type SQL } from "@gym/db/orm";
import type { Column } from "@gym/db/orm";
import {
  authIdentities,
  autopayMandates,
  bodyMetrics,
  bookings,
  checkIns,
  consents,
  exercises,
  invoiceLines,
  invoices,
  leads,
  leadTasks,
  ledgerEntries,
  memberPasses,
  members,
  membershipFreezes,
  memberships,
  notificationPreferences,
  notifications,
  organisations,
  otpChallenges,
  payments,
  personalRecords,
  privacyRequests,
  pushDevices,
  recoveryCodes,
  refreshTokens,
  refunds,
  sessions,
  staffInvites,
  staffMembers,
  userMfa,
  users,
  workouts,
  workoutSets,
  workoutTemplates,
} from "@gym/db/schema";

type Rows = Record<string, unknown>[];

/** Personal-data tables left out of the download, and why (the registry lists them all). */
export const NOT_EXPORTED = {
  audit_log: "a security log; ask the grievance officer for entries about you",
  outbox_events: "a short-lived system queue, deleted within 7 days",
  idempotency_keys: "stored replies to repeated requests, deleted within 24 hours",
  member_imports: "member lists uploaded by a gym, emptied 30 days after upload",
} as const;

/** Credentials are never exported, only that they exist: hashes, encrypted secrets. */
const SECRET = /(hash|secret|enc)$/i;
const redact = (rows: Rows): Rows =>
  rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !SECRET.test(key))));

export const anyOf = (column: Column, values: readonly (string | null)[]): SQL => {
  const present = values.filter((v): v is string => Boolean(v));
  return present.length ? inArray(column, present) : sql`false`;
};

/**
 * Everything held about one person, keyed by table, from every gym they belong to. Run inside withPrivacy (the
 * only scope that may read across gyms). Rows are found through the person's account and their member records.
 */
export async function collectPersonalData(tx: Tx, userId: string) {
  const [user] = await tx.select().from(users).where(eq(users.id, userId));
  if (!user) throw new Error("user not found");
  const contacts = [user.phone, user.email];
  const memberRows = await tx.select().from(members).where(eq(members.userId, userId));
  const memberIds = memberRows.map((m) => m.id);
  const sessionRows = await tx.select().from(sessions).where(eq(sessions.userId, userId));
  const leadRows = await tx
    .select()
    .from(leads)
    .where(
      or(
        anyOf(leads.memberId, memberIds),
        anyOf(leads.phone, contacts),
        anyOf(leads.email, contacts),
      ),
    );
  const membershipRows = await tx
    .select()
    .from(memberships)
    .where(anyOf(memberships.memberId, memberIds));
  const invoiceRows = await tx.select().from(invoices).where(anyOf(invoices.memberId, memberIds));
  const paymentRows = await tx.select().from(payments).where(anyOf(payments.memberId, memberIds));

  const data: Record<string, Rows> = {
    users: [user],
    sessions: sessionRows,
    refresh_tokens: await tx
      .select()
      .from(refreshTokens)
      .where(
        anyOf(
          refreshTokens.sessionId,
          sessionRows.map((s) => s.id),
        ),
      ),
    otp_challenges: await tx
      .select()
      .from(otpChallenges)
      .where(anyOf(otpChallenges.destination, contacts)),
    auth_identities: await tx
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.userId, userId)),
    user_mfa: await tx.select().from(userMfa).where(eq(userMfa.userId, userId)),
    recovery_codes: await tx.select().from(recoveryCodes).where(eq(recoveryCodes.userId, userId)),
    consents: await tx.select().from(consents).where(eq(consents.userId, userId)),
    push_devices: await tx.select().from(pushDevices).where(eq(pushDevices.userId, userId)),
    staff_members: await tx.select().from(staffMembers).where(eq(staffMembers.userId, userId)),
    staff_invites: await tx
      .select()
      .from(staffInvites)
      .where(anyOf(staffInvites.destination, contacts)),
    exercises: await tx.select().from(exercises).where(eq(exercises.userId, userId)),
    workouts: await tx.select().from(workouts).where(eq(workouts.userId, userId)),
    workout_sets: await tx.select().from(workoutSets).where(eq(workoutSets.userId, userId)),
    workout_templates: await tx
      .select()
      .from(workoutTemplates)
      .where(eq(workoutTemplates.userId, userId)),
    personal_records: await tx
      .select()
      .from(personalRecords)
      .where(eq(personalRecords.userId, userId)),
    body_metrics: await tx.select().from(bodyMetrics).where(eq(bodyMetrics.userId, userId)),
    privacy_requests: await tx
      .select({
        id: privacyRequests.id,
        kind: privacyRequests.kind,
        status: privacyRequests.status,
        requestedAt: privacyRequests.requestedAt,
        completedAt: privacyRequests.completedAt,
      })
      .from(privacyRequests)
      .where(eq(privacyRequests.userId, userId)),
    members: memberRows,
    member_passes: await tx
      .select()
      .from(memberPasses)
      .where(anyOf(memberPasses.memberId, memberIds)),
    membership_freezes: await tx
      .select()
      .from(membershipFreezes)
      .where(
        anyOf(
          membershipFreezes.membershipId,
          membershipRows.map((m) => m.id),
        ),
      ),
    notifications: await tx
      .select()
      .from(notifications)
      .where(anyOf(notifications.memberId, memberIds)),
    notification_preferences: await tx
      .select()
      .from(notificationPreferences)
      .where(anyOf(notificationPreferences.memberId, memberIds)),
    leads: leadRows,
    lead_tasks: await tx
      .select()
      .from(leadTasks)
      .where(
        anyOf(
          leadTasks.leadId,
          leadRows.map((l) => l.id),
        ),
      ),
    memberships: membershipRows,
    check_ins: await tx.select().from(checkIns).where(anyOf(checkIns.memberId, memberIds)),
    bookings: await tx.select().from(bookings).where(anyOf(bookings.memberId, memberIds)),
    invoices: invoiceRows,
    invoice_lines: await tx
      .select()
      .from(invoiceLines)
      .where(
        anyOf(
          invoiceLines.invoiceId,
          invoiceRows.map((i) => i.id),
        ),
      ),
    payments: paymentRows,
    refunds: await tx
      .select()
      .from(refunds)
      .where(
        anyOf(
          refunds.paymentId,
          paymentRows.map((p) => p.id),
        ),
      ),
    ledger_entries: await tx
      .select()
      .from(ledgerEntries)
      .where(anyOf(ledgerEntries.memberId, memberIds)),
    autopay_mandates: await tx
      .select()
      .from(autopayMandates)
      .where(anyOf(autopayMandates.memberId, memberIds)),
  };
  const gyms = await tx
    .select({ id: organisations.id, name: organisations.name })
    .from(organisations)
    .where(
      anyOf(
        organisations.id,
        memberRows.map((m) => m.tenantId),
      ),
    );

  return {
    format: "gym-platform-export/1",
    exportedAt: new Date().toISOString(),
    gyms,
    notIncluded: NOT_EXPORTED,
    data: Object.fromEntries(Object.entries(data).map(([table, rows]) => [table, redact(rows)])),
  };
}

export type PersonalDataExport = Awaited<ReturnType<typeof collectPersonalData>>;
