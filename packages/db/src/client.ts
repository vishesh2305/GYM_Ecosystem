import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;
export interface DbHandle {
  db: Database;
  pool: Pool;
}

export function createDb(url: string, max = 10): DbHandle {
  const pool = new Pool({ connectionString: url, max });
  return { db: drizzle(pool, { schema }), pool };
}

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, {
    migrationsFolder,
    migrationsSchema: "drizzle",
    migrationsTable: "__migrations",
  });
}
