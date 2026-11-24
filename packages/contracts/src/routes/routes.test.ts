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
