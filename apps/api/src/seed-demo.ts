// Staging only: loads the demo gym and prints the token of the synthetic check's kiosk (for Terraform's
// synthetic_flows). Run as a one-off task: infra/deploy/deploy.sh staging <image> seed-demo.
import { baseEnvSchema, parseEnv } from "@gym/config";
import { createDb } from "@gym/db";
import { z } from "zod";
import { loadDemo } from "./platform/demo";

const env = parseEnv(
  baseEnvSchema
    .pick({ DATABASE_URL: true })
    .extend({ DEPLOY_ENV: z.enum(["local", "staging", "production"]).default("local") }),
);
if (env.DEPLOY_ENV === "production") throw new Error("Demo data is never loaded into production.");

const { db, pool } = createDb(env.DATABASE_URL, 1);
try {
  const token = await loadDemo(db);
  process.stdout.write(`Demo gym ready. Synthetic check kiosk token: ${token}\n`);
} finally {
  await pool.end();
}
