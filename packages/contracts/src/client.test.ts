import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, createClient } from "./client";
import { defineRoute } from "./route";

const getMember = defineRoute({
  method: "GET",
  path: "/v1/members/{memberId}",
  summary: "Get a member",
  tag: "members",
  params: z.object({ memberId: z.string() }),
  query: z.object({ tags: z.array(z.string()).optional(), q: z.string().optional() }),
  response: z.object({ id: z.string() }),
});

const createMember = defineRoute({
  method: "POST",
  path: "/v1/members",
  summary: "Create",
  tag: "members",
  body: z.object({ name: z.string() }),
  response: z.object({ id: z.string() }),
  status: 201,
});

const removeMember = defineRoute({
  method: "DELETE",
  path: "/v1/members/{memberId}",
  summary: "Delete",
  tag: "members",
  params: z.object({ memberId: z.string() }),
  response: z.undefined(),
  status: 204,
});

const health = defineRoute({
  method: "GET",
  path: "/v1/health",
  summary: "h",
  tag: "system",
  response: z.object({ status: z.literal("ok") }),
});

const json = (status: number, body: unknown, type = "application/json") =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": type },
  });

describe("createClient", () => {
  it("fills path params (encoded), query arrays and auth headers", async () => {
    const fetch = vi.fn(async () => json(200, { id: "m1" }));
    const call = createClient({
      baseUrl: "https://api.test",
      fetch,
      headers: async () => ({ authorization: "Bearer t" }),
    });
    const result = await call(getMember, {
      params: { memberId: "a/b" },
      query: { tags: ["x", "y"], q: undefined },
    });
    expect(result).toEqual({ id: "m1" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/v1/members/a%2Fb?tags=x&tags=y");
    expect(init.method).toBe("GET");
    expect(init.headers).toMatchObject({ authorization: "Bearer t", accept: "application/json" });
  });

  it("sends a JSON body and works for routes without input", async () => {
    const fetch = vi.fn(async () => json(201, { id: "m2" }));
    const call = createClient({ baseUrl: "https://api.test/", fetch });
    await expect(call(createMember, { body: { name: "Asha" } })).resolves.toEqual({ id: "m2" });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe(JSON.stringify({ name: "Asha" }));
    expect(init.headers).toMatchObject({ "content-type": "application/json" });

    fetch.mockResolvedValueOnce(json(200, { status: "ok" }));
    await expect(call(health)).resolves.toEqual({ status: "ok" });
    expect((fetch.mock.calls[1] as unknown as [string])[0]).toBe("https://api.test/v1/health");
  });

  it("handles 204 No Content", async () => {
    const call = createClient({
      baseUrl: "https://api.test",
      fetch: async () => new Response(null, { status: 204 }),
    });
    await expect(call(removeMember, { params: { memberId: "m1" } })).resolves.toBeUndefined();
  });

  it("throws ApiError carrying the problem details on non-2xx", async () => {
    const problem = {
      type: "about:blank",
      title: "Bad Request",
      status: 400,
      errors: [{ path: "name", message: "Required" }],
    };
    const call = createClient({
      baseUrl: "https://api.test",
      fetch: async () => json(400, problem, "application/problem+json"),
    });
    const error = await call(createMember, { body: { name: "" } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).problem).toEqual(problem);
  });

  it("throws ApiError without problem when the error body is not a problem document", async () => {
    const call = createClient({
      baseUrl: "https://api.test",
      fetch: async () => new Response("<html>bad gateway</html>", { status: 502 }),
    });
    const error = (await call(health).catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(502);
    expect(error.problem).toBeUndefined();
  });

  it("rejects a response that does not match the contract", async () => {
    const call = createClient({
      baseUrl: "https://api.test",
      fetch: async () => json(200, { status: "degraded" }),
    });
    await expect(call(health)).rejects.toThrow();
  });

  it("refuses to call with a missing path parameter", async () => {
    const call = createClient({ baseUrl: "https://api.test", fetch: async () => json(200, {}) });
    await expect(
      call(getMember, { params: {} as { memberId: string }, query: {} }),
    ).rejects.toThrow(TypeError);
  });
});
