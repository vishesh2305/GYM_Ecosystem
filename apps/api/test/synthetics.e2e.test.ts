import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "@gym/db";
import { createApp } from "../src/app";
import { loadDemo } from "../src/platform/demo";
import { testEnv } from "./helpers";

const SCRIPT = new URL("../../../infra/synthetics/critical-flows.js", import.meta.url);
const PHONE = "+919910000001"; // the first demo member, who has a running membership
const WEBHOOK_SECRET = "synthetic-webhook-secret";

let api: Awaited<ReturnType<typeof createApp>>["app"];
let dbh: DbHandle;
let kioskToken: string;
let replacedToken: string;

beforeAll(async () => {
  const env = testEnv({
    DEPLOY_ENV: "staging",
    OTP_TEST_NUMBERS: `${PHONE}:135790`,
    RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
  });
  ({ app: api } = await createApp(env));
  await api.listen({ port: 0, host: "0.0.0.0" });
  dbh = createDb(env.DATABASE_URL);
  // Loading twice replaces the kiosk: only the newest token works.
  replacedToken = await loadDemo(dbh.db);
  kioskToken = await loadDemo(dbh.db);
});
afterAll(async () => {
  await api.close();
  await dbh.pool.end();
});

describe("synthetic check of sign-in, check-in and payments", () => {
  it("loading the demo again replaces the synthetic kiosk, so an old token stops working", async () => {
    const kiosk = (token: string) =>
      api.inject({ url: "/v1/kiosk", headers: { "x-kiosk-token": token } });
    expect((await kiosk(replacedToken)).statusCode).toBe(401);
    expect((await kiosk(kioskToken)).statusCode).toBe(200);
  });

  it("passes against a running API, exactly as Grafana runs it", async () => {
    const { port } = api.getHttpServer().address() as AddressInfo;
    const env = {
      BASE_URL: `http://host.docker.internal:${port}`,
      SYNTH_PHONE: PHONE,
      SYNTH_OTP: "135790",
      SYNTH_KIOSK_TOKEN: kioskToken,
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
