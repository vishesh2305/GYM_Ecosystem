import { describe, expect, it } from "vitest";
import { entryDenial, type EntryFacts } from "./access";

const running = {
  status: "active",
  startDate: "2026-12-01",
  endDate: "2026-12-31",
  branchIds: [],
} as const;
const base: EntryFacts = {
  today: "2026-12-10",
  branchId: "b1",
  memberships: [running],
  overdueInvoices: 0,
};
const only = (m: Partial<EntryFacts["memberships"][number]>, extra: Partial<EntryFacts> = {}) =>
  entryDenial({ ...base, ...extra, memberships: [{ ...running, ...m }] });

describe("entryDenial", () => {
  it("lets in a member whose membership runs today, at any branch it covers", () => {
    expect(entryDenial(base)).toBeNull();
    expect(only({ status: "trial" })).toBeNull();
    expect(only({ status: "pending", startDate: "2026-12-10" })).toBeNull();
    expect(only({ branchIds: ["b2", "b1"] })).toBeNull();
    expect(only({ startDate: "2026-12-10", endDate: "2026-12-10" })).toBeNull();
  });

  it("turns away members without a running membership, saying why", () => {
    expect(entryDenial({ ...base, memberships: [] })).toBe("no_active_membership");
    expect(only({ endDate: "2026-12-09" })).toBe("no_active_membership");
    expect(only({ status: "pending", startDate: "2026-12-11" })).toBe("no_active_membership");
    expect(only({ status: "expired" })).toBe("no_active_membership");
    expect(only({ status: "cancelled" })).toBe("no_active_membership");
    expect(only({ status: "frozen" })).toBe("membership_paused");
    expect(only({ branchIds: ["b2"] })).toBe("wrong_branch");
    expect(only({}, { overdueInvoices: 1 })).toBe("dues_unpaid");
  });

  it("any one membership that fits is enough", () => {
    expect(
      entryDenial({
        ...base,
        memberships: [
          { status: "active", startDate: "2026-12-01", endDate: "2026-12-31", branchIds: ["b2"] },
          { status: "active", startDate: "2026-12-01", endDate: "2026-12-31", branchIds: ["b1"] },
        ],
      }),
    ).toBeNull();
  });
});
