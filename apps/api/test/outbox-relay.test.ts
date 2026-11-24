import type { Database } from "@gym/db";
import type { Queue } from "bullmq";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { EventEnvelope } from "../src/platform/events";
import { OutboxRelay } from "../src/worker/outbox-relay";

describe("OutboxRelay loop", () => {
  it("survives database errors: logs and keeps polling until stopped", async () => {
    const db = {
      transaction: vi.fn().mockRejectedValue(new Error("connection refused")),
    } as unknown as Database;
    const logger = { error: vi.fn() } as unknown as Logger;
    const relay = new OutboxRelay(db, {} as Queue<EventEnvelope>, logger, 100, 5);

    relay.start();
    relay.start(); // idempotent
    await vi.waitFor(() =>
      expect(vi.mocked(logger.error).mock.calls.length).toBeGreaterThanOrEqual(3),
    );
    relay.stop();
    const calls = vi.mocked(db.transaction).mock.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(vi.mocked(db.transaction).mock.calls.length).toBe(calls);
  });
});
