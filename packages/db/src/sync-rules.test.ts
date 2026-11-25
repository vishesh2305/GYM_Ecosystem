import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";
import { parse } from "yaml";
import { createDb, type DbHandle } from "./client";
import { exercises, users, workouts, workoutSets, workoutTemplates } from "./schema";

/**
 * Runs the PowerSync sync rules as the service would (a role that bypasses RLS) and checks that a phone
 * downloads the shared library and its owner's rows, and never a row belonging to anyone else.
 */
type Rules = { bucket_definitions: Record<string, { parameters?: string; data: string[] }> };
const rules = parse(
  readFileSync(new URL("../powersync/sync-rules.yaml", import.meta.url), "utf8"),
) as Rules;

const tableOf = (query: string) => /\bFROM\s+(\w+)/i.exec(query)?.[1] ?? "";
const allQueries = Object.values(rules.bucket_definitions).flatMap((b) => b.data);
const syncedTables = [...new Set(allQueries.map(tableOf))].sort();

let handle: DbHandle;

/** Everything one phone would download, per table. */
async function download(userId: string) {
  const rows = new Map<string, Record<string, unknown>[]>();
  const run = async (query: string, params: unknown[]) =>
    (
      await handle.pool.query(
        query.replace(/request\.user_id\(\)|bucket\.user_id/g, "$1::uuid"),
        params,
      )
    ).rows as Record<string, unknown>[];
  for (const bucket of Object.values(rules.bucket_definitions)) {
    const instances = bucket.parameters ? await run(bucket.parameters, [userId]) : [{}];
    for (const instance of instances) {
      for (const query of bucket.data) {
        const params = "user_id" in instance ? [instance.user_id] : [];
        rows.set(tableOf(query), [
          ...(rows.get(tableOf(query)) ?? []),
          ...(await run(query, params)),
        ]);
      }
    }
  }
  return rows;
}

async function personWithTraining(name: string) {
  const [user] = await handle.db.insert(users).values({ name }).returning();
  if (!user) throw new Error("insert failed");
  const [exercise] = await handle.db
    .insert(exercises)
    .values({
      userId: user.id,
      name: `${name}'s curl`,
      primaryMuscle: "biceps",
      equipment: "other",
      tracking: "weight_reps",
    })
    .returning();
  const [workout] = await handle.db
    .insert(workouts)
    .values({ userId: user.id, name: `${name}'s arms`, startedAt: new Date() })
    .returning();
  if (!exercise || !workout) throw new Error("insert failed");
  await handle.db.insert(workoutSets).values({
    userId: user.id,
    workoutId: workout.id,
    exerciseId: exercise.id,
    position: 1,
    reps: 10,
    weightKg: 12.5,
  });
  await handle.db.insert(workoutTemplates).values({ userId: user.id, name: `${name}'s plan` });
  return user.id;
}

beforeAll(() => {
  handle = createDb(inject("databaseUrl"));
});
afterAll(async () => {
  await handle.pool.end();
});

describe("PowerSync sync rules", () => {
  it("send a phone the shared library and its owner's rows, never anyone else's", async () => {
    const alice = await personWithTraining("Alice");
    const bob = await personWithTraining("Bob");

    const phone = await download(alice);
    for (const table of ["exercises", "workouts", "workout_sets", "workout_templates"]) {
      const rows = phone.get(table) ?? [];
      expect(
        rows.some((r) => r.user_id === alice),
        table,
      ).toBe(true);
      expect(
        rows.every((r) => r.user_id === alice || r.user_id === null),
        table,
      ).toBe(true);
    }
    expect(JSON.stringify([...phone.values()])).not.toContain(bob);
    expect((phone.get("exercises") ?? []).filter((r) => r.user_id === null).length).toBeGreaterThan(
      50,
    );
  });

  it("cover exactly the tables in the powersync publication, all protected by row-level security", async () => {
    const published = await handle.pool.query<{ tablename: string }>(
      "select tablename from pg_publication_tables where pubname = 'powersync' order by tablename",
    );
    expect(published.rows.map((r) => r.tablename)).toEqual(syncedTables);
    const secured = await handle.pool.query<{ relname: string }>(
      "select relname from pg_class where relname = any($1) and relrowsecurity and relforcerowsecurity",
      [syncedTables],
    );
    expect(secured.rows.map((r) => r.relname).sort()).toEqual(syncedTables);
  });
});
