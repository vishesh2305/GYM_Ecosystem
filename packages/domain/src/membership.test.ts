import { describe, expect, it } from "vitest";
import {
  canTransition,
  initialStatus,
  MEMBERSHIP_STATUSES,
  type MembershipStatus,
} from "./membership";

const ALLOWED: Record<MembershipStatus, MembershipStatus[]> = {
  pending: ["active", "trial", "cancelled"],
  trial: ["expired", "cancelled"],
  active: ["frozen", "expired", "cancelled"],
  frozen: ["active", "cancelled"],
  expired: [],
  cancelled: [],
};

describe("membership status changes", () => {
  it("allows exactly the documented changes, for every pair of statuses", () => {
    for (const from of MEMBERSHIP_STATUSES) {
      for (const to of MEMBERSHIP_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(ALLOWED[from].includes(to));
      }
    }
  });
});

describe("a new membership's first status", () => {
  it("is pending when it starts later, otherwise trial or active", () => {
    expect(initialStatus({ startDate: "2026-12-01", today: "2026-11-25", isTrial: false })).toBe(
      "pending",
    );
    expect(initialStatus({ startDate: "2026-11-25", today: "2026-11-25", isTrial: true })).toBe(
      "trial",
    );
    expect(initialStatus({ startDate: "2026-11-25", today: "2026-11-25", isTrial: false })).toBe(
      "active",
    );
  });
});

import { unfreezeSplit } from "./membership";

describe("unfreezing early", () => {
  it("counts frozen days before today as used and the rest as unused", () => {
    expect(unfreezeSplit({ startsOn: "2026-11-01", days: 10, today: "2026-11-04" })).toEqual({
      usedDays: 3,
      unusedDays: 7,
    });
  });
  it("same-day unfreeze uses nothing; returning after the planned end uses everything", () => {
    expect(unfreezeSplit({ startsOn: "2026-11-01", days: 10, today: "2026-11-01" })).toEqual({
      usedDays: 0,
      unusedDays: 10,
    });
    expect(unfreezeSplit({ startsOn: "2026-11-01", days: 10, today: "2026-11-30" })).toEqual({
      usedDays: 10,
      unusedDays: 0,
    });
  });
});

import fc from "fast-check";
import { prorateCredit } from "./membership";

describe("credit for the unused part of a membership", () => {
  it("credits the days from today to the end, including today", () => {
    // 30-day membership, 10 days used (1-10 Nov), switching on 11 Nov: 20 of 30 days unused.
    expect(
      prorateCredit({
        pricePaise: 300_000,
        startDate: "2026-11-01",
        endDate: "2026-11-30",
        today: "2026-11-11",
      }),
    ).toEqual({
      totalDays: 30,
      unusedDays: 20,
      creditPaise: 200_000,
    });
  });

  it("credits everything before the start and nothing after the end", () => {
    const m = { pricePaise: 150_000, startDate: "2026-12-01", endDate: "2026-12-31" };
    expect(prorateCredit({ ...m, today: "2026-11-25" }).creditPaise).toBe(150_000);
    expect(prorateCredit({ ...m, today: "2027-01-05" }).creditPaise).toBe(0);
  });

  it("never loses or creates a paisa, and never credits more than was paid (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 1, max: 400 }),
        fc.integer({ min: -30, max: 430 }),
        (price, length, offset) => {
          const startDate = "2026-01-01";
          const endDate = new Date(Date.UTC(2026, 0, length)).toISOString().slice(0, 10);
          const today = new Date(Date.UTC(2026, 0, 1 + offset)).toISOString().slice(0, 10);
          const { creditPaise } = prorateCredit({ pricePaise: price, startDate, endDate, today });
          expect(Number.isInteger(creditPaise)).toBe(true);
          expect(creditPaise).toBeGreaterThanOrEqual(0);
          expect(creditPaise).toBeLessThanOrEqual(price);
        },
      ),
    );
  });
});
