import { createDb, withTenant, type DbHandle } from "@gym/db";
import {
  auditLog,
  featureFlags,
  handledEvents,
  idempotencyKeys,
  outboxEvents,
} from "@gym/db/schema";
import { eq, sql } from "@gym/db/orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { recordAudit } from "../src/platform/audit";
import { appendEvent, defineHandler } from "../src/platform/events";
import { FeatureFlags } from "../src/platform/feature-flags.service";
import { requestHash } from "../src/platform/idempotency";
import { runMaintenance } from "../src/platform/maintenance";
import { createWorker, type WorkerHandle } from "../src/worker/create-worker";
import { testEnv } from "./helpers";
import { TestModule, testDoomed, testPinged, testState } from "./test.module";

const TENANT = "0193a1b2-0000-7000-8000-0000000000aa";
let api: Awaited<ReturnType<typeof createApp>>["app"];
let dbh: DbHandle;

const charge = (key: string | undefined, amount = 100) =>
  api.inject({
    method: "POST",
    url: "/v1/_test/charge",
    headers: key === undefined ? {} : { "idempotency-key": key },
    payload: { amount },
  });

beforeAll(async () => {
  ({ app: api } = await createApp(testEnv(), { modules: [TestModule] }));
  dbh = createDb(testEnv().DATABASE_URL);
});
afterAll(async () => {
  await api.close();
  await dbh.pool.end();
});
beforeEach(() => {
  testState.charges = 0;
  testState.failNext = false;
});

describe("idempotency keys", () => {
  it("replays the stored response and runs the handler once", async () => {
    const first = await charge("key-replay-1");
    const second = await charge("key-replay-1");
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(testState.charges).toBe(1);
  });

  it("rejects the same key with a different request (422)", async () => {
    await charge("key-mismatch-1", 100);
    const res = await charge("key-mismatch-1", 200);
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/different request/);
  });

  it("requires the header on routes marked @RequireIdempotencyKey", async () => {
    const res = await charge(undefined);
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(/Idempotency-Key header is required/);
    expect(testState.charges).toBe(0);
  });

  it("rejects malformed keys", async () => {
    expect((await charge("x".repeat(256))).statusCode).toBe(400);
    expect((await charge("has space")).statusCode).toBe(400);
  });

  it("releases the key when the handler fails, so a retry runs", async () => {
    testState.failNext = true;
    expect((await charge("key-retry-1")).statusCode).toBe(400);
    const retry = await charge("key-retry-1");
    expect(retry.statusCode).toBe(201);
    expect(retry.headers["idempotent-replayed"]).toBeUndefined();
    expect(testState.charges).toBe(1);
  });

  it("answers 409 while the same key is still in progress", async () => {
    const [a, b] = await Promise.all([charge("key-race-1", 999), charge("key-race-1", 999)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect(testState.charges).toBe(1);
  });

  it("takes over a stale in-progress key left by a crashed request", async () => {
    const body = { amount: 100 };
    await dbh.db.insert(idempotencyKeys).values({
      scope: "ip:127.0.0.1",
      key: "key-stale-1",
      requestHash: requestHash("POST", "/v1/_test/charge", body),
      lockedAt: new Date(Date.now() - 5 * 60_000),
    });
    const res = await charge("key-stale-1");
    expect(res.statusCode).toBe(201);
    expect(testState.charges).toBe(1);
  });

  it("is optional elsewhere and ignored on GET", async () => {
    await api.inject({ method: "POST", url: "/v1/_test/note", payload: { a: 1 } });
    await api.inject({ method: "POST", url: "/v1/_test/note", payload: { a: 1 } });
    expect(testState.charges).toBe(2);
    const get = await api.inject({
      method: "GET",
      url: "/v1/health",
      headers: { "idempotency-key": "k" },
    });
    expect(get.statusCode).toBe(200);
  });
});

describe("outbox → queue → handler", () => {
  let worker: WorkerHandle;
  const seen: { id: string; tenantId: string | null; message: string }[] = [];
  let doomedCalls = 0;

  const pinged = defineHandler({
    name: "test.record-ping",
    event: testPinged,
    async handle(payload, { tx, event }) {
      const { rows } = await tx.execute(sql`select current_setting('app.tenant_id', true) as t`);
      seen.push({ id: event.id, tenantId: (rows[0] as { t: string }).t, message: payload.message });
    },
  });
  const doomed = defineHandler({
    name: "test.always-fails",
    event: testDoomed,
    async handle() {
      doomedCalls += 1;
      throw new Error("downstream is down");
    },
  });

  const ping = async (message: string, event: "pinged" | "doomed" = "pinged") =>
    (
      await api.inject({
        method: "POST",
        url: "/v1/_test/ping",
        payload: { tenantId: TENANT, message, event },
      })
    ).json().eventId as string;

  beforeAll(async () => {
    worker = await createWorker(testEnv({ EVENT_MAX_ATTEMPTS: "2", EVENT_BACKOFF_MS: "10" }), {
      handlers: [pinged, doomed],
      autostart: false,
    });
    await worker.queue.obliterate({ force: true });
  });
  afterAll(async () => {
    await worker.close();
  });

  it("an API write lands in the outbox, is relayed once, handled once in the tenant's scope", async () => {
    const id = await ping("hello");
    const [row] = await dbh.db.select().from(outboxEvents).where(eq(outboxEvents.id, id));
    expect(row?.publishedAt).toBeNull();

    expect(await worker.relay.drainOnce()).toBeGreaterThanOrEqual(1); // other test files share the outbox
    const [after] = await dbh.db.select().from(outboxEvents).where(eq(outboxEvents.id, id));
    expect(after?.publishedAt).toBeInstanceOf(Date);
    const job = await worker.queue.getJob(id);
    expect(job?.name).toBe("test.pinged");

    worker.dispatcher.start();
    await job?.waitUntilFinished(worker.queueEvents, 10_000);
    expect(seen).toEqual([{ id, tenantId: TENANT, message: "hello" }]);
  });

  it("a relay crash after enqueue does not enqueue twice (jobId = event id)", async () => {
    await worker.dispatcher.pause();
    const id = await ping("crash");
    await worker.relay.drainOnce();
    await dbh.db.update(outboxEvents).set({ publishedAt: null }).where(eq(outboxEvents.id, id));
    expect(await worker.relay.drainOnce()).toBeGreaterThanOrEqual(1); // other test files share the outbox
    const jobs = await worker.queue.getJobs(["waiting", "prioritized", "delayed", "completed"]);
    expect(jobs.filter((j) => j.id === id)).toHaveLength(1);
    worker.dispatcher.start();
    await (await worker.queue.getJob(id))?.waitUntilFinished(worker.queueEvents, 10_000);
    expect(seen.filter((s) => s.id === id)).toHaveLength(1);
  });

  it("a redelivered event is handled only once (handled_events marker)", async () => {
    const id = await ping("dup");
    await worker.relay.drainOnce();
    await (await worker.queue.getJob(id))?.waitUntilFinished(worker.queueEvents, 10_000);
    const original = await worker.queue.getJob(id);
    if (!original) throw new Error(`job ${id} not found`);
    const copy = await worker.queue.add(original.name, original.data, {
      jobId: `${id}-redelivery`,
    });
    await copy.waitUntilFinished(worker.queueEvents, 10_000);
    expect(seen.filter((s) => s.id === id)).toHaveLength(1);
  });

  it("a failing handler retries with backoff, then lands in the failed set (DLQ)", async () => {
    const id = await ping("boom", "doomed");
    await worker.relay.drainOnce();
    const job = await worker.queue.getJob(id);
    await expect(job?.waitUntilFinished(worker.queueEvents, 10_000)).rejects.toThrow(
      /downstream is down/,
    );
    const failed = await worker.queue.getJob(id);
    expect(await failed?.getState()).toBe("failed");
    expect(failed?.attemptsMade).toBe(2);
    expect(doomedCalls).toBe(2);
    const markers = await dbh.db.select().from(handledEvents).where(eq(handledEvents.eventId, id));
    expect(markers).toEqual([]);
  });

  it("rejects an event payload that breaks its schema", async () => {
    await expect(
      withTenant(dbh.db, TENANT, (tx) =>
        appendEvent(tx, testPinged, { message: 42 } as never, TENANT),
      ),
    ).rejects.toThrow();
  });

  it("an auto-started worker relays and handles events with no manual steps", async () => {
    await worker.dispatcher.pause();
    const live = await createWorker(testEnv({ OUTBOX_POLL_MS: "20" }), { handlers: [pinged] });
    try {
      const id = await ping("live");
      await vi.waitFor(() => expect(seen.some((s) => s.id === id)).toBe(true), {
        timeout: 10_000,
        interval: 50,
      });
    } finally {
      await live.close();
    }
  });

  it("schedules hourly maintenance", async () => {
    const schedulers = await worker.maintenanceQueue.getJobSchedulers();
    expect(schedulers.map((s) => s.key)).toContain("maintenance-hourly");
  });
});

describe("maintenance", () => {
  it("removes expired idempotency keys, handled markers and old published events only", async () => {
    const old = new Date(Date.now() - 8 * 24 * 3600_000);
    await dbh.db.insert(idempotencyKeys).values([
      { scope: "s", key: "old", requestHash: "h", createdAt: old },
      { scope: "s", key: "fresh", requestHash: "h" },
    ]);
    await dbh.db
      .insert(handledEvents)
      .values({ eventId: "0193a1b2-0000-7000-8000-0000000000f1", handler: "h", handledAt: old });
    await dbh.db.insert(outboxEvents).values([
      { type: "x", payload: {}, publishedAt: old },
      { type: "x", payload: {}, publishedAt: null, occurredAt: old },
    ]);
    const result = await runMaintenance(dbh.db);
    expect(result).toMatchObject({
      idempotencyKeys: expect.any(Number),
      handledEvents: 1,
      outboxEvents: 1,
    });
    const keys = await dbh.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.scope, "s"));
    expect(keys.map((k) => k.key)).toEqual(["fresh"]);
    const unpublished = await dbh.db
      .select()
      .from(outboxEvents)
      .where(sql`published_at is null and type = 'x'`);
    expect(unpublished).toHaveLength(1);
  });
});

describe("audit log", () => {
  it("records who did what, in the tenant's scope", async () => {
    await withTenant(dbh.db, TENANT, (tx) =>
      recordAudit(tx, {
        tenantId: TENANT,
        actorType: "staff",
        actorId: "0193a1b2-0000-7000-8000-0000000000b1",
        action: "plan.price_changed",
        entityType: "plan",
        entityId: "p1",
        data: { from: 99_900, to: 109_900 },
        requestId: "req-12345678",
      }),
    );
    const rows = await dbh.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "plan.price_changed"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: TENANT,
      entityId: "p1",
      data: { from: 99_900, to: 109_900 },
    });
  });
});

describe("feature flags", () => {
  it("evaluates from the database, caches in Redis, and refreshes on invalidate", async () => {
    const flags = api.get(FeatureFlags);
    await flags.invalidate();
    await dbh.db.insert(featureFlags).values({ key: "kiosk-v2", tenantIds: [TENANT] });

    expect(await flags.isEnabled("kiosk-v2", { tenantId: TENANT })).toBe(true);
    expect(
      await flags.isEnabled("kiosk-v2", { tenantId: "0193a1b2-0000-7000-8000-0000000000ff" }),
    ).toBe(false);
    expect(await flags.isEnabled("does-not-exist", { tenantId: TENANT })).toBe(false);

    await dbh.db
      .update(featureFlags)
      .set({ enabled: true, tenantIds: [] })
      .where(eq(featureFlags.key, "kiosk-v2"));
    expect(await flags.isEnabled("kiosk-v2", {})).toBe(false); // still cached
    await flags.invalidate();
    expect(await flags.isEnabled("kiosk-v2", {})).toBe(true);
  });
});
