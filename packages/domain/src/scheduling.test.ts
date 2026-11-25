import { describe, expect, it } from "vitest";
import { weekdayOf, zonedTime } from "./dates";
import { isLateCancel, occurrences } from "./scheduling";

describe("zonedTime", () => {
  it("turns a gym's wall-clock time into the right instant", () => {
    expect(zonedTime("2026-12-01", "07:00", "Asia/Kolkata").toISOString()).toBe(
      "2026-12-01T01:30:00.000Z",
    );
    expect(zonedTime("2026-12-01", "00:15", "Asia/Kolkata").toISOString()).toBe(
      "2026-11-30T18:45:00.000Z",
    );
    expect(zonedTime("2026-07-01", "09:00", "Europe/London").toISOString()).toBe(
      "2026-07-01T08:00:00.000Z",
    );
    expect(zonedTime("2026-01-15", "09:00", "Europe/London").toISOString()).toBe(
      "2026-01-15T09:00:00.000Z",
    );
    expect(zonedTime("2026-03-08", "02:30", "America/New_York").toISOString()).toBe(
      "2026-03-08T07:30:00.000Z",
    );
    // 01:30 happens twice when New York's clocks go back: the first one.
    expect(zonedTime("2026-11-01", "01:30", "America/New_York").toISOString()).toBe(
      "2026-11-01T05:30:00.000Z",
    );
  });

  it("refuses times that are not HH:MM", () => {
    for (const bad of ["7:00", "24:00", "12:60", "noon"]) {
      expect(() => zonedTime("2026-12-01", bad, "UTC")).toThrow(RangeError);
    }
  });
});

describe("occurrences", () => {
  it("lists the class days in the window, within its start and end dates", () => {
    expect(weekdayOf("2026-12-07")).toBe(1); // a Monday
    const monWedFri = { weekdays: [1, 3, 5], startsOn: "2026-12-08", endsOn: "2026-12-16" };
    expect(occurrences(monWedFri, "2026-12-07", 14)).toEqual([
      "2026-12-09",
      "2026-12-11",
      "2026-12-14",
      "2026-12-16",
    ]);
    expect(
      occurrences({ weekdays: [0], startsOn: "2026-01-01", endsOn: null }, "2026-12-07", 7),
    ).toEqual(["2026-12-13"]);
  });
});

describe("isLateCancel", () => {
  it("is late inside the window or after the start", () => {
    const start = new Date("2026-12-01T10:00:00Z");
    expect(isLateCancel(start, 120, new Date("2026-12-01T07:59:00Z"))).toBe(false);
    expect(isLateCancel(start, 120, new Date("2026-12-01T08:01:00Z"))).toBe(true);
    expect(isLateCancel(start, 0, new Date("2026-12-01T10:01:00Z"))).toBe(true);
  });
});
