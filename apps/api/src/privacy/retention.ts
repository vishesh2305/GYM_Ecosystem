import { withPrivacy, type Database } from "@gym/db";
import { and, inArray, isNotNull, lt, or } from "@gym/db/orm";
import {
  leads,
  leadTasks,
  memberImports,
  notifications,
  otpChallenges,
  sessions,
  staffInvites,
} from "@gym/db/schema";

const DAY = 86_400_000;

/**
 * How long personal data is kept once it has served its purpose (DPDP Act 2023: no longer than needed). Records
 * the law requires (invoices, payments, memberships) and the append-only audit log are not on this list.
 */
export const RETENTION_DAYS = {
  /** Sign-in codes. */
  otpChallenges: 1,
  /** Sessions after they were signed out or expired. */
  endedSessions: 30,
  /** Staff invitations after they were accepted, revoked or expired. */
  closedInvites: 30,
  /** The uploaded file of a member import (the import's result stays). */
  importFiles: 30,
  /** Messages sent to members. */
  notifications: 365,
  /** Contact details of enquiries that ended (joined or lost), and their finished follow-ups. */
  closedLeads: 365,
} as const;

/** Applies RETENTION_DAYS; runs hourly in the worker as app_privacy. Idempotent. */
export async function runRetention(db: Database, now: Date = new Date()) {
  const before = (days: number) => new Date(now.getTime() - days * DAY);
  return withPrivacy(db, async (tx) => {
    const n = async (rows: Promise<unknown[]>) => (await rows).length;
    const endedBefore = before(RETENTION_DAYS.endedSessions);
    const invitesBefore = before(RETENTION_DAYS.closedInvites);
    const leadsBefore = before(RETENTION_DAYS.closedLeads);
    return {
      otpChallenges: await n(
        tx
          .delete(otpChallenges)
          .where(lt(otpChallenges.createdAt, before(RETENTION_DAYS.otpChallenges)))
          .returning(),
      ),
      sessions: await n(
        tx
          .delete(sessions)
          .where(or(lt(sessions.revokedAt, endedBefore), lt(sessions.expiresAt, endedBefore)))
          .returning(),
      ),
      staffInvites: await n(
        tx
          .delete(staffInvites)
          .where(
            or(
              lt(staffInvites.acceptedAt, invitesBefore),
              lt(staffInvites.revokedAt, invitesBefore),
              lt(staffInvites.expiresAt, invitesBefore),
            ),
          )
          .returning(),
      ),
      importFiles: await n(
        tx
          .update(memberImports)
          .set({ content: null })
          .where(
            and(
              isNotNull(memberImports.content),
              lt(memberImports.createdAt, before(RETENTION_DAYS.importFiles)),
            ),
          )
          .returning(),
      ),
      notifications: await n(
        tx
          .delete(notifications)
          .where(lt(notifications.createdAt, before(RETENTION_DAYS.notifications)))
          .returning(),
      ),
      leadTasks: await n(
        tx
          .delete(leadTasks)
          .where(and(isNotNull(leadTasks.doneAt), lt(leadTasks.doneAt, leadsBefore)))
          .returning(),
      ),
      closedLeads: await n(
        tx
          .update(leads)
          .set({
            name: "Closed enquiry",
            phone: null,
            email: null,
            interest: null,
            consentAt: null,
          })
          .where(
            and(
              inArray(leads.stage, ["won", "lost"]),
              lt(leads.updatedAt, leadsBefore),
              or(isNotNull(leads.phone), isNotNull(leads.email)),
            ),
          )
          .returning(),
      ),
    };
  });
}
