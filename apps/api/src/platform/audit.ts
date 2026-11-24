import type { Tx } from "@gym/db";
import { auditLog } from "@gym/db/schema";

export type AuditEntry = Omit<typeof auditLog.$inferInsert, "id" | "createdAt">;

/** Record an action in the caller's transaction. The table is append-only (trigger + grants). */
export async function recordAudit(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLog).values(entry);
}
