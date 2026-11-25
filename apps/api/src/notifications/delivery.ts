import { withSystem, withTenant, type Database, type Tx } from "@gym/db";
import { and, asc, eq, isNull, lte, sql } from "@gym/db/orm";
import { members, notifications, organisations } from "@gym/db/schema";
import {
  MESSAGE_TEMPLATES,
  quietUntil,
  renderMessage,
  type MessageKey,
  type MessageVars,
} from "@gym/domain";
import type { ChannelAdapter, Recipient } from "./channels";
import { preferencesOf } from "./preferences";

/**
 * Queue a message for a member, inside the caller's (tenant-scoped) transaction. The dedupe key makes a
 * trigger that fires again (a retried event, a job running twice) a no-op. Returns whether it was queued.
 */
export async function notify(
  tx: Tx,
  input: {
    tenantId: string;
    memberId: string;
    key: MessageKey;
    vars: MessageVars;
    dedupeKey: string;
    sendAfter?: Date;
    expiresAt?: Date;
  },
): Promise<boolean> {
  const queued = await tx
    .insert(notifications)
    .values(input)
    .onConflictDoNothing()
    .returning({ id: notifications.id });
  return queued.length > 0;
}

export interface DeliveryOptions {
  /** Most messages sent per gym per run: a per-gym throttle, so one gym's burst cannot starve the others. */
  perGym: number;
  maxAttempts: number;
  retryMs: number;
}

export interface DeliveryTotals {
  sent: number;
  /** Held back until the member's quiet hours end. */
  deferred: number;
  retrying: number;
  failed: number;
  skipped: number;
}

type Notification = typeof notifications.$inferSelect;

async function pushTokens(tx: Tx, memberId: string): Promise<string[]> {
  const result = await tx.execute<{ token: string }>(
    sql`select app.member_push_tokens(${memberId}) as token`,
  );
  return result.rows.map((r) => r.token);
}

const disableTokens = (tx: Tx, memberId: string, tokens: readonly string[]) =>
  tx.execute(sql`select app.disable_push_tokens(${memberId}, ${sql.param([...tokens])}::text[])`);

/** Sends one message over the first channel that works, or schedules a retry. */
async function deliver(
  tx: Tx,
  n: Notification,
  org: { timezone: string },
  channels: readonly ChannelAdapter[],
  options: DeliveryOptions,
  now: Date,
): Promise<keyof DeliveryTotals> {
  const finish = async (
    outcome: keyof DeliveryTotals,
    changes: Partial<typeof notifications.$inferInsert>,
  ) => {
    await tx
      .update(notifications)
      .set({ ...changes, updatedAt: now })
      .where(eq(notifications.id, n.id));
    return outcome;
  };

  if (n.expiresAt && n.expiresAt <= now)
    return finish("skipped", { status: "skipped", lastError: "expired before it could be sent" });
  const [member] = await tx
    .select()
    .from(members)
    .where(and(eq(members.id, n.memberId), isNull(members.deletedAt)));
  if (!member) return finish("skipped", { status: "skipped", lastError: "member removed" });

  const template = MESSAGE_TEMPLATES[n.key];
  const prefs = await preferencesOf(tx, member.id);
  if ((prefs.mutedCategories as readonly string[]).includes(template.category))
    return finish("skipped", { status: "skipped", lastError: "muted by the member" });
  const quietEnds = template.urgent
    ? null
    : quietUntil(now, org.timezone, { start: prefs.quietStart, end: prefs.quietEnd });
  if (quietEnds) return finish("deferred", { sendAfter: quietEnds });

  const recipient: Recipient = {
    phone: member.phone,
    email: member.email,
    pushTokens: await pushTokens(tx, member.id),
  };
  const usable = channels.filter(
    (c) => !prefs.disabledChannels.includes(c.channel) && c.reaches(recipient),
  );
  if (!usable.length)
    return finish("skipped", { status: "skipped", lastError: "no way to reach the member" });

  const locale = prefs.locale;
  const message = renderMessage(n.key, locale, n.vars, org.timezone);
  const errors: string[] = [];
  for (const adapter of usable) {
    try {
      const result = await adapter.send(recipient, { key: n.key, locale, message });
      if (result.deadTokens?.length) await disableTokens(tx, member.id, result.deadTokens);
      return finish("sent", {
        status: "sent",
        channel: adapter.channel,
        providerMessageId: result.providerId,
        attempts: n.attempts + 1,
        sentAt: now,
        lastError: errors.join("; ") || null,
      });
    } catch (error) {
      const dead = (error as { deadTokens?: readonly string[] }).deadTokens;
      if (dead?.length) await disableTokens(tx, member.id, dead);
      errors.push(`${adapter.channel}: ${error instanceof Error ? error.message : "failed"}`);
    }
  }
  const attempts = n.attempts + 1;
  const lastError = errors.join("; ");
  return attempts >= options.maxAttempts
    ? finish("failed", { status: "failed", attempts, lastError })
    : finish("retrying", {
        attempts,
        lastError,
        sendAfter: new Date(now.getTime() + options.retryMs),
      });
}

/**
 * Sends due messages, gym by gym, at most `perGym` per gym per run. Rows are claimed with SKIP LOCKED so two
 * workers never send the same message.
 */
export async function runNotificationDelivery(
  db: Database,
  channels: readonly ChannelAdapter[],
  options: DeliveryOptions,
  now: Date = new Date(),
): Promise<DeliveryTotals> {
  const orgs = await withSystem(db, (tx) =>
    tx
      .select({ id: organisations.id, timezone: organisations.timezone })
      .from(organisations)
      .where(isNull(organisations.deletedAt)),
  );
  const totals: DeliveryTotals = { sent: 0, deferred: 0, retrying: 0, failed: 0, skipped: 0 };
  for (const org of orgs) {
    // shortcut: providers are called inside the claiming transaction; fine at a few hundred per run, move to
    // claim-then-send if runs get long.
    await withTenant(db, org.id, async (tx) => {
      const due = await tx
        .select()
        .from(notifications)
        .where(and(eq(notifications.status, "pending"), lte(notifications.sendAfter, now)))
        .orderBy(asc(notifications.sendAfter), asc(notifications.id))
        .limit(options.perGym)
        .for("update", { skipLocked: true });
      for (const n of due) totals[await deliver(tx, n, org, channels, options, now)] += 1;
    });
  }
  return totals;
}
