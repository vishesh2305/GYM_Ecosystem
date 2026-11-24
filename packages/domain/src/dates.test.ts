import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDays, addMonths, daysBetween, isDate, todayIn } from "./dates";

describe("calendar dates (YYYY-MM-DD, no time zone)", () => {
  it("validates real dates only", () => {
    expect(isDate("2026-02-28")).toBe(true);
    expect(isDate("2028-02-29")).toBe(true);
    for (const bad of [
      "2026-02-29",
      "2026-13-01",
      "2026-1-1",
      "26-01-01",
      "2026-01-01T00:00",
      "",
    ]) {
      expect(isDate(bad)).toBe(false);
    }
  });

  it("adds days across month and year ends", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("adds months, keeping the day or using the last day of a shorter month", () => {
    expect(addMonths("2026-01-15", 1)).toBe("2026-02-15");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-11-30", 3)).toBe("2027-02-28");
    expect(addMonths("2026-05-31", -1)).toBe("2026-04-30");
  });

  it("counts days between dates (property: addDays and daysBetween agree)", () => {
    expect(daysBetween("2026-01-01", "2026-12-31")).toBe(364);
    fc.assert(
      fc.property(fc.integer({ min: -2000, max: 2000 }), (n) => {
        expect(daysBetween("2026-06-15", addDays("2026-06-15", n))).toBe(n);
      }),
    );
  });

  it("knows today's date in a gym's time zone", () => {
    const instant = new Date("2026-11-24T20:00:00Z"); // 01:30 next day in India
    expect(todayIn("Asia/Kolkata", instant)).toBe("2026-11-25");
    expect(todayIn("America/New_York", instant)).toBe("2026-11-24");
  });

  it("rejects invalid input", () => {
    expect(() => addDays("2026-02-30", 1)).toThrow(RangeError);
    expect(() => addMonths("nope", 1)).toThrow(RangeError);
  });
});
