import { describe, expect, it } from "vitest";
import { GST_RATES_BPS, planEndDate, priceBreakdown } from "./plans";

describe("planEndDate (inclusive last day)", () => {
  it("day plans last exactly that many days", () => {
    expect(planEndDate("2026-01-01", { unit: "day", count: 1 })).toBe("2026-01-01");
    expect(planEndDate("2026-01-01", { unit: "day", count: 30 })).toBe("2026-01-30");
  });

  it("month plans end the day before the same date next period", () => {
    expect(planEndDate("2026-01-15", { unit: "month", count: 1 })).toBe("2026-02-14");
    expect(planEndDate("2026-01-01", { unit: "month", count: 12 })).toBe("2026-12-31");
    expect(planEndDate("2026-01-31", { unit: "month", count: 1 })).toBe("2026-02-27");
  });
});

describe("priceBreakdown", () => {
  it("adds 18% GST to the plan price and joining fee", () => {
    expect(
      priceBreakdown({ pricePaise: 150_000, joiningFeePaise: 50_000, gstRateBps: 1800 }),
    ).toEqual({
      pricePaise: 150_000,
      joiningFeePaise: 50_000,
      taxablePaise: 200_000,
      gstPaise: 36_000,
      totalPaise: 236_000,
    });
  });

  it("supports GST-exempt plans and rounds tax half up", () => {
    expect(
      priceBreakdown({ pricePaise: 99_999, joiningFeePaise: 0, gstRateBps: 0 }).totalPaise,
    ).toBe(99_999);
    expect(priceBreakdown({ pricePaise: 999, joiningFeePaise: 0, gstRateBps: 1800 }).gstPaise).toBe(
      180,
    );
  });

  it("only accepts Indian GST slabs", () => {
    expect(GST_RATES_BPS).toEqual([0, 500, 1200, 1800, 2800]);
    expect(() => priceBreakdown({ pricePaise: 100, joiningFeePaise: 0, gstRateBps: 1700 })).toThrow(
      RangeError,
    );
  });
});
