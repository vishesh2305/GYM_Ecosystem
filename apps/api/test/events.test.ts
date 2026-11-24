import { describe, expect, it } from "vitest";
import { requireTenant } from "../src/platform/events";

describe("requireTenant", () => {
  const event = {
    id: "e1",
    type: "membership.created",
    payload: {},
    occurredAt: "2026-11-25T00:00:00Z",
  };
  it("returns the tenant of a tenant-scoped event", () => {
    expect(requireTenant({ ...event, tenantId: "t1" })).toBe("t1");
  });
  it("fails loudly when the tenant is missing", () => {
    expect(() => requireTenant({ ...event, tenantId: null })).toThrow(/has no tenant/);
  });
});
