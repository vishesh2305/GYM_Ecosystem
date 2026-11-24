import { allocate } from "./money";

/** Indian financial year label for a date, e.g. 2026-05-10 → "26-27" (April to March). */
export function fiscalYear(date: string): string {
  const year = Number(date.slice(0, 4));
  const start = Number(date.slice(5, 7)) >= 4 ? year : year - 1;
  return `${String(start % 100).padStart(2, "0")}-${String((start + 1) % 100).padStart(2, "0")}`;
}

const PREFIX = { invoice: "INV", credit_note: "CN" } as const;

/** GST invoice numbers must be unique per financial year and at most 16 characters. */
export function documentNumber(kind: keyof typeof PREFIX, fy: string, sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 999_999) {
    throw new RangeError("document sequence must be between 1 and 999999");
  }
  return `${PREFIX[kind]}/${fy}/${String(sequence).padStart(6, "0")}`;
}

/** Supplies at the gym are intra-state: GST is split equally into central (CGST) and state (SGST) tax. */
export function splitGst(gstPaise: number): { cgstPaise: number; sgstPaise: number } {
  if (gstPaise === 0) return { cgstPaise: 0, sgstPaise: 0 };
  const [cgstPaise = 0, sgstPaise = 0] = allocate(gstPaise, [1, 1]);
  return { cgstPaise, sgstPaise };
}
