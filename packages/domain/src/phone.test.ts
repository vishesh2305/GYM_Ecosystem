import { describe, expect, it } from "vitest";
import { normalizePhone } from "./phone";

describe("normalizePhone", () => {
  it("turns local Indian numbers into international format", () => {
    expect(normalizePhone("98123 45678", "IN")).toBe("+919812345678");
    expect(normalizePhone("098123-45678", "IN")).toBe("+919812345678");
  });

  it("keeps numbers that already have a country code", () => {
    expect(normalizePhone("+44 20 7946 0958", "IN")).toBe("+442079460958");
    expect(normalizePhone("+1 (415) 555-2671", "IN")).toBe("+14155552671");
  });

  it("rejects things that are not valid phone numbers", () => {
    for (const bad of ["", "123", "abcdefghij", "+91 12345", "9".repeat(30)]) {
      expect(normalizePhone(bad, "IN")).toBeNull();
    }
  });
});
