// Brings the database schema up to date; the deploy runs it once before new API and worker tasks start.
import { baseEnvSchema, parseEnv } from "@gym/config";
import { createDb, runMigrations } from "@gym/db";

const env = parseEnv(baseEnvSchema.pick({ DATABASE_URL: true }));
const { db, pool } = createDb(env.DATABASE_URL, 1);
try {
  await runMigrations(db);
  process.stdout.write("Database is up to date.\n");
} finally {
  await pool.end();
}
