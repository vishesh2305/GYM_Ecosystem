import { createDb, DEMO, seed, withTenant, type DbHandle } from "@gym/db";
import { kiosks } from "@gym/db/schema";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { hashToken } from "../src/common/crypto";
import { testEnv } from "./helpers";

const SCRIPT = new URL("../../../infra/synthetics/critical-flows.js", import.meta.url);
const PHONE = "+919910000001"; // the first demo member, who has a running membership
const WEBHOOK_SECRET = "synthetic-webhook-secret";
const KIOSK_TOKEN = `kio.${DEMO.orgId}.synthetic-kiosk-secret`;

let api: Awaited<ReturnType<typeof createApp>>["app"];
let dbh: DbHandle;

beforeAll(async () => {
  const env = testEnv({
    DEPLOY_ENV: "staging",
    OTP_TEST_NUMBERS: `${PHONE}:135790`,
    RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
  });
  ({ app: api } = await createApp(env));
  await api.listen({ port: 0, host: "0.0.0.0" });
  dbh = createDb(env.DATABASE_URL);
  await seed(dbh.db);
  await withTenant(dbh.db, DEMO.orgId, (tx) =>
    tx.insert(kiosks).values({
      tenantId: DEMO.orgId,
      branchId: DEMO.branchIds[0],
      name: "Synthetic check",
      tokenHash: hashToken(KIOSK_TOKEN),
      createdBy: DEMO.staff[0]?.id,
    }),
  );
});
afterAll(async () => {
  await api.close();
  await dbh.pool.end();
});

describe("synthetic check of sign-in, check-in and payments", () => {
  it("passes against a running API, exactly as Grafana runs it", async () => {
    const { port } = api.getHttpServer().address() as AddressInfo;
    const env = {
      BASE_URL: `http://host.docker.internal:${port}`,
      SYNTH_PHONE: PHONE,
      SYNTH_OTP: "135790",
      SYNTH_KIOSK_TOKEN: KIOSK_TOKEN,
      SYNTH_WEBHOOK_SECRET: WEBHOOK_SECRET,
    };
    const args = ["run", "--rm", "-i", "--add-host=host.docker.internal:host-gateway"];
    for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
    args.push("grafana/k6:2.3.0", "run", "--quiet", "--no-color", "-");
    const child = promisify(execFile)("docker", args, { timeout: 120_000 });
    child.child.stdin?.end(readFileSync(SCRIPT));
    // On failure, show k6's report (which checks failed) instead of only its exit code.
    const { stdout } = await child.catch((e: { stdout?: string }) => {
      throw new Error(e.stdout ?? String(e));
    });
    for (const name of [
      "signed in",
      "kiosk let the member in",
      "checked out",
      "signed notification accepted",
      "forged notification refused",
    ])
      expect(stdout).toContain(`✓ ${name}`);
    expect(stdout).not.toContain("✗");
  }, 180_000);
});
