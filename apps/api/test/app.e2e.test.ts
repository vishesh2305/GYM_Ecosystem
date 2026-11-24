import { createClient, routes } from "@gym/contracts";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Redis } from "ioredis";
import { version } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { testEnv } from "./helpers";
import { TestModule } from "./test.module";

let app: NestFastifyApplication;
let registered: ReadonlySet<string>;
const PROBLEM = "application/problem+json";

beforeAll(async () => {
  ({ app, routes: registered } = await createApp(testEnv(), { modules: [TestModule] }));
});
afterAll(async () => {
  await app.close();
});

describe("health and readiness", () => {
  it("GET /v1/health is 200 and returns a UUIDv7 request id", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    expect(version(String(res.headers["x-request-id"]))).toBe(7);
  });

  it("echoes a well-formed incoming x-request-id and replaces a malformed one", async () => {
    const good = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { "x-request-id": "trace-abc-12345" },
    });
    expect(good.headers["x-request-id"]).toBe("trace-abc-12345");
    const bad = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { "x-request-id": "bad id\n<script>" },
    });
    expect(bad.headers["x-request-id"]).not.toContain("script");
  });

  it("GET /v1/ready is 200 when database and cache respond", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", checks: { database: "ok", cache: "ok" } });
  });

  it("GET /v1/ready is 503 problem naming the failed dependency", async () => {
    const { app: broken } = await createApp(testEnv({ REDIS_URL: "redis://127.0.0.1:1" }));
    try {
      const res = await broken.inject({ method: "GET", url: "/v1/ready" });
      expect(res.statusCode).toBe(503);
      expect(res.headers["content-type"]).toContain(PROBLEM);
      expect(res.json()).toMatchObject({
        status: 503,
        title: "Service Unavailable",
        detail: "Not ready: cache",
      });
    } finally {
      await broken.close();
    }
  });
});

describe("errors are RFC 9457 problem details", () => {
  it("400 lists every invalid field", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/_test/echo",
      payload: { name: "A", age: 1.5 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toContain(PROBLEM);
    const body = res.json();
    expect(body).toMatchObject({ type: "about:blank", title: "Bad Request", status: 400 });
    expect(body.errors.map((e: { path: string }) => e.path).sort()).toEqual(["age", "name"]);
    expect(body.requestId).toBe(res.headers["x-request-id"]);
  });

  it("valid input passes through the pipe", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/_test/echo",
      payload: { name: "Asha" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ name: "Asha" });
  });

  it("404 for unknown routes", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain(PROBLEM);
    expect(res.json()).toMatchObject({ status: 404, title: "Not Found" });
  });

  it("500 hides internal error details", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/_test/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("hunter2");
    expect(res.json()).toMatchObject({ status: 500, title: "Internal Server Error" });
    expect(res.json().detail).toBeUndefined();
  });

  it("413 when the body is over the limit", async () => {
    const { app: small } = await createApp(testEnv({ BODY_LIMIT_BYTES: "100" }), {
      modules: [TestModule],
    });
    try {
      const res = await small.inject({
        method: "POST",
        url: "/v1/_test/echo",
        payload: { name: "x".repeat(500) },
      });
      expect(res.statusCode).toBe(413);
      expect(res.headers["content-type"]).toContain(PROBLEM);
      expect(res.json()).toMatchObject({ status: 413 });
    } finally {
      await small.close();
    }
  });

  it("malformed JSON is a 400 problem", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/_test/echo",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toContain(PROBLEM);
  });
});

describe("rate limiting (Redis-backed)", () => {
  it("returns 429 problem with retry-after once the limit is hit", async () => {
    const redis = new Redis(testEnv().REDIS_URL);
    await redis.flushall();
    await redis.quit();
    const { app: limited } = await createApp(testEnv({ RATE_LIMIT_MAX: "3" }));
    try {
      const codes: number[] = [];
      let last;
      for (let i = 0; i < 4; i++) {
        last = await limited.inject({
          method: "GET",
          url: "/v1/health",
          remoteAddress: "10.9.8.7",
        });
        codes.push(last.statusCode);
      }
      expect(codes).toEqual([200, 200, 200, 429]);
      expect(last?.headers["retry-after"]).toBeDefined();
      expect(last?.headers["content-type"]).toContain(PROBLEM);
      expect(last?.json()).toMatchObject({ status: 429, title: "Too Many Requests" });
      const other = await limited.inject({
        method: "GET",
        url: "/v1/health",
        remoteAddress: "10.9.8.8",
      });
      expect(other.statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });
});

describe("security headers and CORS", () => {
  it("sets helmet headers", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["strict-transport-security"]).toBeDefined();
  });

  it("allows only configured origins", async () => {
    const preflight = (origin: string) =>
      app.inject({
        method: "OPTIONS",
        url: "/v1/health",
        headers: { origin, "access-control-request-method": "GET" },
      });
    expect((await preflight("https://app.gym.test")).headers["access-control-allow-origin"]).toBe(
      "https://app.gym.test",
    );
    expect(
      (await preflight("https://evil.test")).headers["access-control-allow-origin"],
    ).toBeUndefined();
  });
});

describe("API contract", () => {
  it("serves the OpenAPI document", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/docs.json" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      openapi: "3.1.0",
      paths: { "/v1/health": { get: { operationId: "health" } } },
    });
  });

  it("every contract route is served, and every served /v1 route is in the contract", () => {
    const contract = new Set(
      Object.values(routes).map((r) => `${r.method} ${r.path.replace(/\{(\w+)\}/g, ":$1")}`),
    );
    const served = [...registered].filter(
      (r) => r.includes(" /v1/") && !r.includes("/v1/_test/") && !r.endsWith("/v1/docs.json"),
    );
    expect(new Set(served)).toEqual(contract);
  });

  it("the typed client works against the running server", async () => {
    const { app: live } = await createApp(testEnv());
    try {
      await live.listen({ port: 0, host: "127.0.0.1" });
      const call = createClient({ baseUrl: await live.getUrl() });
      await expect(call(routes.health)).resolves.toEqual({ status: "ok" });
      await expect(call(routes.ready)).resolves.toMatchObject({ status: "ok" });
    } finally {
      await live.close();
    }
  });
});
