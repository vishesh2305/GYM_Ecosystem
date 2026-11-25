import { createDb, type DbHandle } from "@gym/db";
import { exercises } from "@gym/db/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { signedInUser, testEnv } from "./helpers";

let api: Awaited<ReturnType<typeof createApp>>["app"];
let dbh: DbHandle;

beforeAll(async () => {
  ({ app: api } = await createApp(testEnv()));
  dbh = createDb(testEnv().DATABASE_URL);
});
afterAll(async () => {
  await api.close();
  await dbh.pool.end();
});

type Exercise = {
  id: string;
  name: string;
  primaryMuscle: string;
  equipment: string;
  mine: boolean;
};

const get = async (url: string, headers: Record<string, string>) => {
  const res = await api.inject({ method: "GET", url, headers });
  expect(res.statusCode).toBe(200);
  return res.json() as Exercise[];
};

describe("exercise library", () => {
  it("needs a signed-in person", async () => {
    expect((await api.inject({ method: "GET", url: "/v1/exercises" })).statusCode).toBe(401);
  });

  it("lists the shared library, searchable by name, muscle and equipment", async () => {
    const me = await signedInUser(api, dbh.db);
    const all = await get("/v1/exercises", me.headers);
    expect(all.length).toBeGreaterThanOrEqual(60);
    expect(all.every((e) => !e.mine)).toBe(true);

    const bench = await get("/v1/exercises?q=bench%20press", me.headers);
    expect(bench.map((e) => e.name)).toEqual(
      expect.arrayContaining(["Bench Press (Barbell)", "Bench Press (Dumbbell)"]),
    );
    // "%" is a literal character, not a wildcard.
    expect(await get("/v1/exercises?q=%25", me.headers)).toEqual([]);

    // Triceps also matches exercises that work them secondarily, like the bench press.
    const triceps = await get("/v1/exercises?muscle=triceps", me.headers);
    expect(triceps.map((e) => e.name)).toEqual(
      expect.arrayContaining(["Triceps Pushdown (Cable)", "Bench Press (Barbell)"]),
    );
    const kettlebell = await get("/v1/exercises?equipment=kettlebell", me.headers);
    expect(kettlebell.length).toBeGreaterThan(0);
    expect(kettlebell.every((e) => e.equipment === "kettlebell")).toBe(true);
  });

  it("includes my own exercises but never someone else's", async () => {
    const me = await signedInUser(api, dbh.db);
    const other = await signedInUser(api, dbh.db);
    const own = (userId: string, name: string) => ({
      userId,
      name,
      primaryMuscle: "glutes",
      equipment: "machine",
      tracking: "weight_reps" as const,
    });
    await dbh.db
      .insert(exercises)
      .values([own(me.user.id, "My glute machine"), own(other.user.id, "Their glute machine")]);
    const glutes = await get("/v1/exercises?q=glute%20machine", me.headers);
    expect(glutes).toEqual([expect.objectContaining({ name: "My glute machine", mine: true })]);
  });
});
