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
