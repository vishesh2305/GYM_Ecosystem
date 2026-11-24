/** Ledger accounts per gym. A member's dues are the `receivable` lines tagged with their member id. */
export const LEDGER_ACCOUNTS = [
  "receivable", // money members owe the gym
  "revenue", // membership and joining-fee income (before GST)
  "gst_cgst", // GST collected for the central government
  "gst_sgst", // GST collected for the state government
  "gst_igst", // GST on inter-state supplies
  "cash", // cash in the till
  "bank", // UPI-to-QR, card terminal, settled online payments
  "gateway_clearing", // online payments captured but not yet settled by the gateway
] as const;
export type LedgerAccount = (typeof LEDGER_ACCOUNTS)[number];

export interface JournalLine {
  account: LedgerAccount;
  debitPaise?: number;
  creditPaise?: number;
  memberId?: string | null;
}

/** Every journal must balance: total debits = total credits, each line one-sided and positive. */
export function assertBalanced(lines: readonly JournalLine[]): void {
  if (lines.length < 2) throw new RangeError("a journal needs at least two lines");
  let debit = 0;
  let credit = 0;
  for (const line of lines) {
    const d = line.debitPaise ?? 0;
    const c = line.creditPaise ?? 0;
    if (!Number.isSafeInteger(d) || !Number.isSafeInteger(c) || d < 0 || c < 0) {
      throw new RangeError("ledger amounts must be non-negative whole paise");
    }
    if (d > 0 === c > 0) throw new RangeError("each ledger line is either a debit or a credit");
    debit += d;
    credit += c;
  }
  if (debit !== credit)
    throw new RangeError(`journal is not balanced: debits ${debit} ≠ credits ${credit}`);
}
