import { describe, expect, it } from "vitest";
import { buildOpenApi } from "../openapi";
import { routes } from "./index";

describe("the real API contract", () => {
  it("builds a valid OpenAPI document with no duplicate method + path", () => {
    const doc = buildOpenApi(routes, { title: "t", version: "1" });
    const operations = Object.values(doc.paths).flatMap((item) => Object.values(item));
    expect(operations).toHaveLength(Object.keys(routes).length);
  });

  it("every route is versioned, tagged and summarised", () => {
    for (const route of Object.values(routes)) {
      expect(route.path).toMatch(/^\/v1\//);
      expect(route.tag.length).toBeGreaterThan(0);
      expect(route.summary.length).toBeGreaterThan(5);
    }
  });
});

describe("validation rules shared by the apps and the server", () => {
  it("a lead needs a phone number or an email so someone can follow up", () => {
    const lead = {
      name: "Rohan",
      branchId: "01930000-0000-7000-8000-0000000000ff",
      source: "walk_in",
    };
    expect(routes.createLead.body.safeParse(lead).success).toBe(false);
    expect(routes.createLead.body.safeParse({ ...lead, phone: "9876543210" }).success).toBe(true);
    expect(routes.createLead.body.safeParse({ ...lead, email: "r@example.com" }).success).toBe(
      true,
    );
  });

  const plan = { name: "Monthly", durationUnit: "month", durationCount: 1, pricePaise: 150_000 };

  it("a plan lasts at most 36 months but may be counted in days", () => {
    expect(routes.createPlan.body.safeParse(plan).success).toBe(true);
    expect(routes.createPlan.body.safeParse({ ...plan, durationCount: 37 }).success).toBe(false);
    expect(
      routes.createPlan.body.safeParse({ ...plan, durationUnit: "day", durationCount: 90 }).success,
    ).toBe(true);
  });

  it("a new plan gets sensible defaults; an edit gets none", () => {
    expect(routes.createPlan.body.parse(plan)).toMatchObject({
      gstRateBps: 1800,
      joiningFeePaise: 0,
      branchIds: [],
    });
    expect(routes.updatePlan.body.parse({ pricePaise: 1 })).toEqual({ pricePaise: 1 });
  });

  it("checks GSTIN format and time zones", () => {
    const org = { name: "Gym", branch: { name: "Main", city: "Pune" } };
    expect(
      routes.createOrganisation.body.safeParse({ ...org, gstin: "27aapfu0939f1zv" }).success,
    ).toBe(true);
    expect(
      routes.createOrganisation.body.safeParse({ ...org, gstin: "27AAPFU0939F1Z" }).success,
    ).toBe(false);
    expect(
      routes.createOrganisation.body.safeParse({ ...org, timezone: "Asia/Kolkata" }).success,
    ).toBe(true);
    expect(
      routes.createOrganisation.body.safeParse({ ...org, timezone: "Asia/Atlantis" }).success,
    ).toBe(false);
  });
});
