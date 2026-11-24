import type { Tx } from "@gym/db";
import { ledgerEntries } from "@gym/db/schema";
import { assertBalanced, type JournalLine } from "@gym/domain";
import { v7 } from "uuid";

/** Post one balanced journal. The database re-checks the balance when the transaction commits. */
export async function postJournal(
  tx: Tx,
  journal: {
    tenantId: string;
    sourceType: string;
    sourceId: string;
    memo?: string;
    lines: JournalLine[];
  },
): Promise<string> {
  assertBalanced(journal.lines);
  const journalId = v7();
  await tx.insert(ledgerEntries).values(
    journal.lines.map((line) => ({
      tenantId: journal.tenantId,
      journalId,
      account: line.account,
      memberId: line.memberId ?? null,
      debitPaise: line.debitPaise ?? 0,
      creditPaise: line.creditPaise ?? 0,
      sourceType: journal.sourceType,
      sourceId: journal.sourceId,
      memo: journal.memo,
    })),
  );
  return journalId;
}
