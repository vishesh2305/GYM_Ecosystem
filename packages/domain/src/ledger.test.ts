import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assertBalanced, LEDGER_ACCOUNTS } from "./ledger";

describe("journals (double-entry)", () => {
  it("accept balanced entries", () => {
    expect(() =>
      assertBalanced([
        { account: "receivable", debitPaise: 236_000 },
        { account: "revenue", creditPaise: 200_000 },
        { account: "gst_cgst", creditPaise: 18_000 },
        { account: "gst_sgst", creditPaise: 18_000 },
      ]),
    ).not.toThrow();
  });

  it("reject unbalanced, empty, negative, both-sided or zero lines", () => {
    expect(() =>
      assertBalanced([
        { account: "cash", debitPaise: 100 },
        { account: "receivable", creditPaise: 99 },
      ]),
    ).toThrow(/balanced/);
    expect(() => assertBalanced([])).toThrow();
    expect(() =>
      assertBalanced([
        { account: "cash", debitPaise: -5 },
        { account: "receivable", creditPaise: -5 },
      ]),
    ).toThrow();
    expect(() => assertBalanced([{ account: "cash", debitPaise: 5, creditPaise: 5 }])).toThrow();
    expect(() => assertBalanced([{ account: "cash" }, { account: "receivable" }])).toThrow();
  });

  it("any amount split across lines stays balanced (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000_000 }),
        fc.integer({ min: 1, max: 6 }),
        (total, parts) => {
          const share = Math.floor(total / parts);
          const credits = Array.from({ length: parts }, (_, i) => ({
            account: LEDGER_ACCOUNTS[1 + (i % 4)] ?? "revenue",
            creditPaise: i === parts - 1 ? total - share * (parts - 1) : share,
          })).filter((l) => l.creditPaise > 0);
          expect(() =>
            assertBalanced([{ account: "receivable", debitPaise: total }, ...credits]),
          ).not.toThrow();
        },
      ),
    );
  });
});
