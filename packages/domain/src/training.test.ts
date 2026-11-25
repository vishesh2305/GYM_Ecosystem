import { describe, expect, it } from "vitest";
import { estimatedOneRepMax, personalBests, type LoggedSet } from "./training";

let n = 0;
const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 10, minute));
const set = (over: Partial<LoggedSet> & { minute?: number }): LoggedSet => ({
  id: `set-${++n}`,
  kind: "normal",
  reps: null,
  weightKg: null,
  durationSeconds: null,
  distanceM: null,
  completedAt: at(over.minute ?? 0),
  ...over,
});
const values = (bests: ReturnType<typeof personalBests>) =>
  Object.fromEntries([...bests].map(([k, b]) => [k, b.value]));

describe("estimatedOneRepMax", () => {
  it("uses Epley's formula, and a single is its own 1RM", () => {
    expect(estimatedOneRepMax(100, 1)).toBe(100);
    expect(estimatedOneRepMax(100, 5)).toBe(116.67);
    expect(estimatedOneRepMax(60, 10)).toBe(80);
  });
});

describe("personalBests", () => {
  it("finds the heaviest weight, best estimated 1RM and best set volume, each from its own set", () => {
    const heavy = set({ weightKg: 100, reps: 2, minute: 1 });
    const strong = set({ weightKg: 90, reps: 6, minute: 2 });
    const volume = set({ weightKg: 70, reps: 12, minute: 3 });
    const bests = personalBests("weight_reps", [heavy, strong, volume]);
    expect(values(bests)).toEqual({ max_weight: 100, est_1rm: 108, best_set_volume: 840 });
    expect(bests.get("max_weight")?.setId).toBe(heavy.id);
    expect(bests.get("est_1rm")?.setId).toBe(strong.id);
    expect(bests.get("best_set_volume")?.setId).toBe(volume.id);
  });

  it("ignores warm-ups, sets not ticked off and empty sets", () => {
    const bests = personalBests("weight_reps", [
      set({ kind: "warmup", weightKg: 200, reps: 1 }),
      set({ weightKg: 150, reps: 1, completedAt: null }),
      set({ weightKg: 0, reps: 10 }),
      set({ weightKg: 50, reps: 0 }),
      set({ weightKg: 40, reps: 5, kind: "drop" }),
    ]);
    expect(values(bests)).toEqual({ max_weight: 40, est_1rm: 46.67, best_set_volume: 200 });
  });

  it("does not estimate a 1RM from very high-rep sets", () => {
    expect(values(personalBests("weight_reps", [set({ weightKg: 20, reps: 30 })]))).toEqual({
      max_weight: 20,
      best_set_volume: 600,
    });
  });

  it("lets the earlier set keep a tied record, whatever order the sets arrive in", () => {
    const later = set({ weightKg: 80, reps: 5, minute: 9 });
    const earlier = set({ weightKg: 80, reps: 5, minute: 4 });
    expect(personalBests("weight_reps", [later, earlier]).get("max_weight")).toEqual({
      value: 80,
      setId: earlier.id,
      achievedAt: earlier.completedAt,
    });
  });

  it("tracks reps, time and distance exercises by their own measure", () => {
    expect(
      values(personalBests("reps", [set({ reps: 12 }), set({ reps: 15, weightKg: 10 })])),
    ).toEqual({
      max_reps: 15,
    });
    expect(
      values(personalBests("time", [set({ durationSeconds: 90 }), set({ durationSeconds: 75 })])),
    ).toEqual({
      max_duration: 90,
    });
    expect(
      values(personalBests("distance", [set({ distanceM: 5000 }), set({ distanceM: 0 })])),
    ).toEqual({
      max_distance: 5000,
    });
  });

  it("has no records without counted sets", () => {
    expect(personalBests("weight_reps", []).size).toBe(0);
    expect(personalBests("time", [set({ reps: 10 })]).size).toBe(0);
  });
});
