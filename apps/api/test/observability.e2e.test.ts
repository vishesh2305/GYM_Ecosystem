import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  MeterProvider,
  MetricReader,
  type GaugeMetricData,
} from "@opentelemetry/sdk-metrics";
import { captureException } from "@sentry/node";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { defineHandler } from "../src/platform/events";
import { createWorker, type WorkerHandle } from "../src/worker/create-worker";
import { testEnv } from "./helpers";
import { TestModule, testDoomed } from "./test.module";

vi.mock("@sentry/node", () => ({ captureException: vi.fn() }));

class Reader extends MetricReader {
  constructor() {
    super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE });
  }
  protected onForceFlush = () => Promise.resolve();
  protected onShutdown = () => Promise.resolve();
}

const reader = new Reader();
metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));

/** Each data point of a gauge as { ...attributes, value }. */
async function gauge(name: string) {
  const { resourceMetrics } = await reader.collect();
  const metric = resourceMetrics.scopeMetrics
    .flatMap((s) => s.metrics)
    .find((m) => m.descriptor.name === name) as GaugeMetricData | undefined;
  return (metric?.dataPoints ?? []).map((p): Record<string, unknown> & { value: number } => ({
    ...p.attributes,
    value: p.value,
  }));
}

const TENANT = "0193a1b2-0000-7000-8000-0000000000bb";
let api: Awaited<ReturnType<typeof createApp>>["app"];
let worker: WorkerHandle;

beforeAll(async () => {
  ({ app: api } = await createApp(testEnv(), { modules: [TestModule] }));
  const doomed = defineHandler({
    name: "test.observability-fails",
    event: testDoomed,
    handle: () => Promise.reject(new Error("downstream is down")),
  });
  worker = await createWorker(testEnv({ EVENT_MAX_ATTEMPTS: "2", EVENT_BACKOFF_MS: "10" }), {
    extraHandlers: [doomed],
    autostart: false,
  });
  await worker.queue.obliterate({ force: true });
});
afterAll(async () => {
  await worker.close();
  await api.close();
});

const ping = async () =>
  (
    await api.inject({
      method: "POST",
      url: "/v1/_test/ping",
      payload: { tenantId: TENANT, message: "x", event: "doomed" },
    })
  ).json<{ eventId: string }>().eventId;

describe("metrics for the dashboards", () => {
  it("shows events waiting in the outbox and how long the oldest has waited", async () => {
    await ping();
    const [backlog] = await gauge("outbox.backlog");
    expect(backlog?.value).toBeGreaterThanOrEqual(1);
    const [age] = await gauge("outbox.oldest_age");
    expect(age?.value).toBeGreaterThanOrEqual(0);
    await worker.relay.drainOnce();
  });

  it("shows background jobs per queue and state, including the dead-letter queue", async () => {
    const points = await gauge("queue.jobs");
    const states = points.filter((p) => p.queue === "events").map((p) => p.state);
    expect(states.sort()).toEqual(["active", "delayed", "failed", "waiting"]);
    expect(points.some((p) => p.queue === "maintenance")).toBe(true);
  });

  it("shows database connections of the API and the worker", async () => {
    const points = await gauge("db.client.connection.count");
    for (const pool of ["primary", "worker"])
      expect(points.filter((p) => p.pool === pool).map((p) => p.state)).toEqual([
        "used",
        "idle",
        "waiting",
      ]);
  });
});

describe("error reporting", () => {
  it("reports server errors, not client errors", async () => {
    vi.mocked(captureException).mockClear();
    expect((await api.inject({ url: "/v1/_test/boom" })).statusCode).toBe(500);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect((await api.inject({ url: "/v1/no-such-route" })).statusCode).toBe(404);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("reports an event only when its retries are used up", async () => {
    vi.mocked(captureException).mockClear();
    const id = await ping();
    await worker.relay.drainOnce();
    worker.dispatcher.start();
    const job = await worker.queue.getJob(id);
    await expect(job?.waitUntilFinished(worker.queueEvents, 10_000)).rejects.toThrow();
    // Two attempts, one report (the event from the first test fails here too, and is reported once too).
    const reports = () =>
      vi
        .mocked(captureException)
        .mock.calls.filter(
          ([, hint]) => (hint as { tags: { eventId?: string } }).tags.eventId === id,
        );
    await vi.waitFor(() => expect(reports()).toHaveLength(1));
    expect(reports()[0]?.[1]).toEqual({ tags: { eventType: "test.doomed", eventId: id } });
  });

  it("reports a failed scheduled job", async () => {
    vi.mocked(captureException).mockClear();
    // A worker whose database is unreachable fails its jobs the way an outage would.
    const broken = await createWorker(testEnv({ DATABASE_URL: "postgres://nobody@127.0.0.1:1/x" }));
    await worker.maintenanceQueue.add("retention", {});
    await vi.waitFor(
      () =>
        expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
          tags: { job: "retention" },
        }),
      { timeout: 10_000 },
    );
    await broken.close();
  });
});
