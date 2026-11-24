import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";
import { createDb, runMigrations } from "../src/client";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

// One throwaway Postgres per test run, migrated from scratch: proves migrations work on a clean DB.
export default async function setup(project: TestProject) {
  const container = await new PostgreSqlContainer("postgres:17-alpine").start();
  const url = container.getConnectionUri();
  const { db, pool } = createDb(url);
  await runMigrations(db);
  await pool.end();
  project.provide("databaseUrl", url);
  return async () => {
    await container.stop();
  };
}
