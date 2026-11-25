import { withPrivacy, type Database } from "@gym/db";
import { and, asc, eq, isNotNull, lt } from "@gym/db/orm";
import { privacyRequests } from "@gym/db/schema";
import { collectPersonalData } from "./export";

/** How long a finished export can be downloaded. */
export const EXPORT_DAYS = 7;
const BATCH = 10;

/**
 * Runs pending privacy requests one at a time (claimed with SKIP LOCKED, so two workers never run the same one)
 * and empties exports past their download window. Every step runs as app_privacy (withPrivacy).
 */
export async function runPrivacyRequests(db: Database, now: Date = new Date()) {
  const expired = await withPrivacy(db, (tx) =>
    tx
      .update(privacyRequests)
      .set({ result: null })
      .where(and(lt(privacyRequests.expiresAt, now), isNotNull(privacyRequests.result)))
      .returning({ id: privacyRequests.id }),
  );
  const totals = { exports: 0, failed: 0, expired: expired.length };
  for (let i = 0; i < BATCH; i++) {
    const outcome = await withPrivacy(db, async (tx) => {
      const [request] = await tx
        .select()
        .from(privacyRequests)
        .where(eq(privacyRequests.status, "pending"))
        .orderBy(asc(privacyRequests.requestedAt))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!request) return null;
      try {
        // A savepoint, so a failing query still lets the request be marked failed.
        const result = await tx.transaction((inner) => collectPersonalData(inner, request.userId));
        await tx
          .update(privacyRequests)
          .set({
            status: "done",
            result,
            completedAt: now,
            expiresAt: new Date(now.getTime() + EXPORT_DAYS * 86_400_000),
          })
          .where(eq(privacyRequests.id, request.id));
        return "exports" as const;
      } catch (error) {
        await tx
          .update(privacyRequests)
          .set({
            status: "failed",
            error: error instanceof Error ? error.message : "failed",
            completedAt: now,
          })
          .where(eq(privacyRequests.id, request.id));
        return "failed" as const;
      }
    });
    if (!outcome) break;
    totals[outcome] += 1;
  }
  return totals;
}
