import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
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
