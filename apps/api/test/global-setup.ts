import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, Wait } from "testcontainers";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const [pg, valkey] = await Promise.all([
    new PostgreSqlContainer("postgres:17-alpine").start(),
    new GenericContainer("valkey/valkey:8-alpine")
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
      .start(),
  ]);
  project.provide("databaseUrl", pg.getConnectionUri());
  project.provide("redisUrl", `redis://${valkey.getHost()}:${valkey.getMappedPort(6379)}`);
  return async () => {
    await Promise.all([pg.stop(), valkey.stop()]);
  };
}
