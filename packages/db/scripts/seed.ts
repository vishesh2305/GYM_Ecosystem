// Load demo data into the database in .env: pnpm db:seed
import { createDb } from "../src/client";
import { DEMO, seed } from "../src/seed";

try {
  process.loadEnvFile("../../.env");
} catch {
  // DATABASE_URL from the environment.
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const { db, pool } = createDb(url);
await seed(db);
await pool.end();
process.stdout.write(
  `Demo data ready: "Demo Fitness" with 2 branches, 4 plans and ${DEMO.memberCount} members. Staff sign in with ${DEMO.staff.map((s) => `${s.phone} (${s.role})`).join(", ")}.\n`,
);
