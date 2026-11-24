import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildOpenApi } from "./openapi";
import { defineRoute } from "./route";

const getMember = defineRoute({
  method: "GET",
  path: "/v1/members/{memberId}",
  summary: "Get a member",
  tag: "members",
  params: z.object({ memberId: z.uuid() }),
  query: z.object({ include: z.enum(["plans"]).optional(), page: z.coerce.number().int() }),
  response: z.object({ id: z.uuid(), name: z.string() }),
});

const createMember = defineRoute({
  method: "POST",
  path: "/v1/members",
  summary: "Create a member",
  tag: "members",
  body: z.object({ name: z.string().min(2) }),
  response: z.object({ id: z.uuid() }),
  status: 201,
});

describe("buildOpenApi", () => {
  const doc = buildOpenApi({ getMember, createMember }, { title: "Gym API", version: "1.0.0" });

  it("emits an OpenAPI 3.1 document with one operation per route", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info).toEqual({ title: "Gym API", version: "1.0.0" });
    expect(Object.keys(doc.paths)).toEqual(["/v1/members/{memberId}", "/v1/members"]);
  });

  it("describes path and query parameters, marking required ones", () => {
    const op = doc.paths["/v1/members/{memberId}"]?.get;
    expect(op?.operationId).toBe("getMember");
    expect(op?.parameters).toEqual([
      {
        name: "memberId",
        in: "path",
        required: true,
        schema: expect.objectContaining({ type: "string", format: "uuid" }),
      },
      {
        name: "include",
        in: "query",
        required: false,
        schema: expect.objectContaining({ enum: ["plans"] }),
      },
      { name: "page", in: "query", required: true, schema: expect.any(Object) },
    ]);
  });

  it("describes the request body, success status and problem responses", () => {
    const op = doc.paths["/v1/members"]?.post;
    expect(op?.requestBody?.content["application/json"].schema).toMatchObject({
      type: "object",
      required: ["name"],
    });
    expect(Object.keys(op?.responses ?? {})).toEqual(["201", "default"]);
    expect(op?.responses.default).toMatchObject({
      content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
    });
    expect(doc.components.schemas.Problem).toMatchObject({ type: "object" });
  });

  it("rejects two routes with the same method and path", () => {
    expect(() =>
      buildOpenApi({ a: createMember, b: createMember }, { title: "x", version: "1" }),
    ).toThrow(/Duplicate route POST \/v1\/members/);
  });
});
