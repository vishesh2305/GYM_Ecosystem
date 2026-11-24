import { describe, expect, it } from "vitest";
import { flagBucket, isFlagOn, type FlagRule } from "./flags";

const flag = (over: Partial<FlagRule> = {}): FlagRule => ({
  key: "new-checkin",
  enabled: false,
  rolloutPercent: 0,
  tenantIds: [],
  userIds: [],
  ...over,
});

const ids = Array.from({ length: 10_000 }, (_, i) => `user-${i}`);

describe("isFlagOn", () => {
  it("uses the global switch when nothing else applies", () => {
    expect(isFlagOn(flag({ enabled: true }), {})).toBe(true);
    expect(isFlagOn(flag({ enabled: false }), { userId: "u1" })).toBe(false);
  });

  it("allow-listed tenants and users are always on", () => {
    expect(isFlagOn(flag({ tenantIds: ["t1"] }), { tenantId: "t1" })).toBe(true);
    expect(isFlagOn(flag({ userIds: ["u1"] }), { tenantId: "t9", userId: "u1" })).toBe(true);
    expect(isFlagOn(flag({ tenantIds: ["t1"] }), { tenantId: "t2" })).toBe(false);
  });

  it("0% and 100% rollouts are exact", () => {
    expect(ids.some((userId) => isFlagOn(flag({ rolloutPercent: 0 }), { userId }))).toBe(false);
    expect(ids.every((userId) => isFlagOn(flag({ rolloutPercent: 100 }), { userId }))).toBe(true);
  });

  it("a percentage rollout reaches roughly that share, stably per subject", () => {
    const f = flag({ rolloutPercent: 20 });
    const on = ids.filter((userId) => isFlagOn(f, { userId }));
    expect(on.length / ids.length).toBeGreaterThan(0.17);
    expect(on.length / ids.length).toBeLessThan(0.23);
    expect(ids.filter((userId) => isFlagOn(f, { userId }))).toEqual(on);
  });

  it("raising the percentage only adds subjects, never removes them", () => {
    const at20 = new Set(
      ids.filter((userId) => isFlagOn(flag({ rolloutPercent: 20 }), { userId })),
    );
    const at50 = new Set(
      ids.filter((userId) => isFlagOn(flag({ rolloutPercent: 50 }), { userId })),
    );
    expect([...at20].every((id) => at50.has(id))).toBe(true);
  });

  it("rolls out by tenant when there is no user", () => {
    const f = flag({ rolloutPercent: 50 });
    const tenants = ids.map((t) => isFlagOn(f, { tenantId: t }));
    expect(tenants.filter(Boolean).length).toBeGreaterThan(4000);
    expect(isFlagOn(f, {})).toBe(false);
  });

  it("different flags bucket the same subject independently", () => {
    const same = ids.filter((id) => flagBucket("flag-a", id) === flagBucket("flag-b", id)).length;
    expect(same).toBeLessThan(300); // ~1% expected by chance
  });

  it("buckets are integers in 0..99", () => {
    for (const id of ids.slice(0, 500)) {
      const b = flagBucket("k", id);
      expect(Number.isInteger(b) && b >= 0 && b < 100).toBe(true);
    }
  });
});
