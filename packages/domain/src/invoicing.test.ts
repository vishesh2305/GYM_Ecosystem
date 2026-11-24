import { describe, expect, it } from "vitest";
import { documentNumber, fiscalYear, paymentStatus, splitGst } from "./invoicing";

describe("Indian financial year (April to March)", () => {
  it("labels dates by the year that starts in April", () => {
    expect(fiscalYear("2026-04-01")).toBe("26-27");
    expect(fiscalYear("2027-03-31")).toBe("26-27");
    expect(fiscalYear("2026-03-31")).toBe("25-26");
  });
});

describe("document numbers", () => {
  it("are short (GST allows 16 characters), prefixed and zero-padded", () => {
    expect(documentNumber("invoice", "26-27", 1)).toBe("INV/26-27/000001");
    expect(documentNumber("credit_note", "26-27", 42)).toBe("CN/26-27/000042");
    expect(documentNumber("invoice", "26-27", 999_999).length).toBeLessThanOrEqual(16);
    expect(() => documentNumber("invoice", "26-27", 1_000_000)).toThrow(RangeError);
  });
});

describe("splitting GST between centre and state", () => {
  it("halves it, giving the odd paisa to CGST", () => {
    expect(splitGst(36_000)).toEqual({ cgstPaise: 18_000, sgstPaise: 18_000 });
    expect(splitGst(181)).toEqual({ cgstPaise: 91, sgstPaise: 90 });
    expect(splitGst(0)).toEqual({ cgstPaise: 0, sgstPaise: 0 });
  });
});

describe("invoice payment status", () => {
  it("follows how much has been paid", () => {
    expect(paymentStatus(1000, 0)).toBe("issued");
    expect(paymentStatus(1000, 1)).toBe("partially_paid");
    expect(paymentStatus(1000, 1000)).toBe("paid");
  });
});
