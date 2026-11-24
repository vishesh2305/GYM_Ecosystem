import { defineConfig } from "drizzle-kit";

try {
  process.loadEnvFile("../../.env");
} catch {
  // No .env (CI): DATABASE_URL comes from the environment.
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  migrations: { schema: "drizzle", table: "__migrations" },
  strict: true,
  verbose: true,
});
