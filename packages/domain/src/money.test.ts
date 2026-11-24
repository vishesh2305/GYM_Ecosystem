import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { allocate, applyBasisPoints } from "./money";

describe("allocate", () => {
  it("splits evenly when it divides", () => {
    expect(allocate(300, [1, 1, 1])).toEqual([100, 100, 100]);
  });

  it("gives leftover paise to the largest remainders first", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
  });

  it("respects ratios", () => {
    expect(allocate(1000, [3, 1])).toEqual([750, 250]);
  });

  it("never loses or creates money (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000_000 }),
        fc
          .array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 12 })
          .filter((r) => r.some((x) => x > 0)),
        (total, ratios) => {
          const parts = allocate(total, ratios);
          expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
          parts.forEach((p, i) => {
            expect(Number.isInteger(p)).toBe(true);
            if (ratios[i] === 0) expect(p).toBe(0);
          });
        },
      ),
    );
  });

  it("rejects bad input", () => {
    expect(() => allocate(10.5, [1])).toThrow(RangeError);
    expect(() => allocate(-1, [1])).toThrow(RangeError);
    expect(() => allocate(10, [])).toThrow(RangeError);
    expect(() => allocate(10, [0, 0])).toThrow(RangeError);
    expect(() => allocate(10, [1, -1])).toThrow(RangeError);
  });

  it("rejects totals that would overflow safe integers", () => {
    expect(() => allocate(Number.MAX_SAFE_INTEGER, [2, 1])).toThrow(RangeError);
  });
});

describe("applyBasisPoints", () => {
  it("computes 18% GST on 999 paise rounding half up", () => {
    expect(applyBasisPoints(999, 1800)).toBe(180); // 179.82 -> 180
  });

  it("rounds exact halves up", () => {
    expect(applyBasisPoints(50, 100)).toBe(1); // 0.5 -> 1
  });

  it("rejects non-integer amounts or rates", () => {
    expect(() => applyBasisPoints(1.5, 100)).toThrow(RangeError);
    expect(() => applyBasisPoints(100, 1.5)).toThrow(RangeError);
    expect(() => applyBasisPoints(-100, 100)).toThrow(RangeError);
  });

  it("rejects amounts that would overflow safe integers", () => {
    expect(() => applyBasisPoints(Number.MAX_SAFE_INTEGER, 1800)).toThrow(RangeError);
  });
});
