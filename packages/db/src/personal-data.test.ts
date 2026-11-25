import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, inject, it } from "vitest";
import { createDb } from "./client";
import { NO_PERSONAL_DATA, PERSONAL_DATA } from "./personal-data";
import * as schema from "./schema";

const tables = Object.values(schema)
  .filter((value) => is(value, PgTable))
  .map((table) => getTableName(table as PgTable))
  .sort();

describe("personal data registry", () => {
  it("classifies every table in the schema exactly once", () => {
    const personal = Object.keys(PERSONAL_DATA);
    const none: readonly string[] = NO_PERSONAL_DATA;
    expect([...personal, ...none].sort()).toEqual(tables);
    expect(personal.filter((t) => none.includes(t))).toEqual([]);
  });

  it("says why any personal data is kept after erasure", () => {
    for (const [table, entry] of Object.entries(PERSONAL_DATA) as [
      string,
      { erasure: string; reason?: string },
    ][])
      if (entry.erasure === "retain") expect(entry.reason, table).toBeTruthy();
  });
});

describe("the privacy job's database role", () => {
  it("can read every personal-data table, so export and erasure never miss one", async () => {
    const handle = createDb(inject("databaseUrl"));
    try {
      const result = await handle.pool.query<{ table_name: string }>(
        `select table_name from information_schema.tables
         where table_schema = 'public' and table_name = any($1)
           and has_table_privilege('app_privacy', 'public.' || table_name, 'SELECT')`,
        [Object.keys(PERSONAL_DATA)],
      );
      expect(result.rows.map((r) => r.table_name).sort()).toEqual(
        Object.keys(PERSONAL_DATA).sort(),
      );
    } finally {
      await handle.pool.end();
    }
  });
});
