import { createDb, type DbHandle } from "@gym/db";
import { and, eq, sql } from "@gym/db/orm";
import { exercises, outboxEvents, workoutSets, workouts } from "@gym/db/schema";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { v7 } from "uuid";
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

type Op = {
  op: "PUT" | "PATCH" | "DELETE";
  type: string;
  id: string;
  data?: Record<string, unknown>;
};
type Headers = Record<string, string>;

const upload = (headers: Headers, batch: Op[]) =>
  api.inject({ method: "POST", url: "/v1/me/sync", headers, payload: { batch } });

/**
 * A scripted stand-in for the app's offline queue (PowerSync's upload queue): every change is recorded
 * locally with ids made on the phone, and uploaded in order when the phone is back online.
 */
class OfflinePhone {
  queue: Op[] = [];
  constructor(readonly headers: Headers) {}

  record(op: Op) {
    this.queue.push(op);
    return op.id;
  }
  startWorkout(name: string, startedAt = new Date()) {
    return this.record({
      op: "PUT",
      type: "workouts",
      id: v7(),
      data: {
        name,
        started_at: startedAt.toISOString(),
        ended_at: null,
        notes: null,
        template_id: null,
      },
    });
  }
  logSet(workoutId: string, exerciseId: string, position: number, reps: number, weightKg: number) {
    return this.record({
      op: "PUT",
      type: "workout_sets",
      id: v7(),
      data: {
        workout_id: workoutId,
        exercise_id: exerciseId,
        position,
        kind: "normal",
        reps,
        weight_kg: weightKg,
        rpe: null,
        duration_seconds: null,
        distance_m: null,
        completed_at: new Date().toISOString(),
      },
    });
  }
  /** Uploads the queue; like the PowerSync client, it is cleared only once the server accepted it. */
  async sync() {
    const res = await upload(this.headers, this.queue);
    expect(res.statusCode).toBe(200);
    const sent = this.queue;
    this.queue = [];
    return { ...(res.json() as { applied: number; skipped: number }), sent };
  }
}

type Workout = {
  id: string;
  name: string;
  updatedAt: string;
  sets: { id: string; reps: number; weightKg: number; position: number }[];
};

async function myWorkouts(headers: Headers) {
  const res = await api.inject({ method: "GET", url: "/v1/me/workouts", headers });
  expect(res.statusCode).toBe(200);
  return res.json() as Workout[];
}

async function libraryId(slug: string) {
  const [row] = await dbh.db.select().from(exercises).where(eq(exercises.slug, slug));
  if (!row) throw new Error(`no library exercise ${slug}`);
  return row.id;
}

describe("offline workout logging and sync", () => {
  it("a workout logged with no signal arrives intact once the phone is back online", async () => {
    const me = await signedInUser(api, dbh.db);
    const phone = new OfflinePhone(me.headers);
    const bench = await libraryId("barbell-bench-press");
    const myExercise = phone.record({
      op: "PUT",
      type: "exercises",
      id: v7(),
      data: {
        name: "Landmine press",
        primary_muscle: "shoulders",
        equipment: "barbell",
        tracking: "weight_reps",
      },
    });
    const workoutId = phone.startWorkout("Push day");
    phone.logSet(workoutId, bench, 1, 8, 60);
    phone.logSet(workoutId, bench, 2, 8, 62.5);
    phone.logSet(workoutId, myExercise, 3, 12, 20);
    phone.record({
      op: "PATCH",
      type: "workouts",
      id: workoutId,
      data: { ended_at: new Date().toISOString() },
    });
    phone.record({
      op: "PUT",
      type: "workout_templates",
      id: v7(),
      data: {
        name: "Push",
        notes: null,
        exercises: JSON.stringify([{ exercise_id: bench, sets: 3, reps: 8 }]),
      },
    });

    const result = await phone.sync();
    expect(result).toMatchObject({ applied: 7, skipped: 0 });
    const [saved] = await myWorkouts(me.headers);
    expect(saved).toMatchObject({ id: workoutId, name: "Push day" });
    expect(saved?.sets.map((s) => [s.position, s.reps, s.weightKg])).toEqual([
      [1, 8, 60],
      [2, 8, 62.5],
      [3, 12, 20],
    ]);

    // The connection dropped before the phone saw the reply, so it sends the same batch again: no duplicates.
    expect((await upload(me.headers, result.sent)).statusCode).toBe(200);
    const again = await myWorkouts(me.headers);
    expect(again).toHaveLength(1);
    expect(again[0]?.sets).toHaveLength(3);
  });

  it("keeps the server's own time and owner, whatever the phone claims", async () => {
    const me = await signedInUser(api, dbh.db);
    const other = await signedInUser(api, dbh.db);
    const before = Date.now();
    const id = v7();
    await upload(me.headers, [
      {
        op: "PUT",
        type: "workouts",
        id,
        data: {
          name: "Legs",
          started_at: new Date().toISOString(),
          user_id: other.user.id,
          updated_at: "2001-01-01T00:00:00Z",
        },
      },
    ]);
    const [row] = await dbh.db.select().from(workouts).where(eq(workouts.id, id));
    expect(row?.userId).toBe(me.user.id);
    expect(row?.updatedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("when two phones change the same set, the last change to reach the server wins", async () => {
    const me = await signedInUser(api, dbh.db);
    const phoneA = new OfflinePhone(me.headers);
    const workoutId = phoneA.startWorkout("Pull day");
    const setId = phoneA.logSet(workoutId, await libraryId("barbell-row"), 1, 10, 50);
    await phoneA.sync();

    const phoneB = new OfflinePhone(me.headers);
    phoneB.record({
      op: "PATCH",
      type: "workout_sets",
      id: setId,
      data: { reps: 8, weight_kg: 55 },
    });
    phoneA.record({ op: "PATCH", type: "workout_sets", id: setId, data: { reps: 12 } });

    await phoneB.sync();
    const afterB = (await myWorkouts(me.headers))[0];
    await phoneA.sync();
    const afterA = (await myWorkouts(me.headers))[0];
    // Each change is per column: A's reps win, B's weight (which A did not touch) stays.
    expect(afterA?.sets[0]).toMatchObject({ reps: 12, weightKg: 55 });
    expect(new Date(afterA?.updatedAt ?? 0).getTime()).toBeGreaterThanOrEqual(
      new Date(afterB?.updatedAt ?? 0).getTime(),
    );
  });

  it("skips changes to rows another phone already deleted instead of blocking the queue", async () => {
    const me = await signedInUser(api, dbh.db);
    const phoneA = new OfflinePhone(me.headers);
    const workoutId = phoneA.startWorkout("Arms");
    const setId = phoneA.logSet(workoutId, await libraryId("barbell-curl"), 1, 10, 30);
    await phoneA.sync();

    phoneA.record({ op: "DELETE", type: "workouts", id: workoutId });
    await phoneA.sync();

    const phoneB = new OfflinePhone(me.headers);
    phoneB.logSet(workoutId, await libraryId("hammer-curl"), 2, 10, 14);
    phoneB.record({ op: "PATCH", type: "workout_sets", id: setId, data: { reps: 11 } });
    phoneB.record({ op: "DELETE", type: "workout_sets", id: setId });
    expect(await phoneB.sync()).toMatchObject({ applied: 0, skipped: 3 });
    expect(await myWorkouts(me.headers)).toEqual([]);
  });

  it("archives my own exercise instead of deleting it, so old sets keep it", async () => {
    const me = await signedInUser(api, dbh.db);
    const phone = new OfflinePhone(me.headers);
    const exerciseId = phone.record({
      op: "PUT",
      type: "exercises",
      id: v7(),
      data: {
        name: "Sled push",
        primary_muscle: "quadriceps",
        equipment: "other",
        tracking: "distance",
      },
    });
    const workoutId = phone.startWorkout("Conditioning");
    phone.record({
      op: "PUT",
      type: "workout_sets",
      id: v7(),
      data: { workout_id: workoutId, exercise_id: exerciseId, position: 1, distance_m: 40 },
    });
    phone.record({ op: "DELETE", type: "exercises", id: exerciseId });
    expect(await phone.sync()).toMatchObject({ applied: 4, skipped: 0 });
    const [row] = await dbh.db.select().from(exercises).where(eq(exercises.id, exerciseId));
    expect(row?.archived).toBe(true);
    expect((await myWorkouts(me.headers))[0]?.sets).toHaveLength(1);
  });

  it("never lets one person read, change or add to another person's training", async () => {
    const alice = await signedInUser(api, dbh.db);
    const mallory = await signedInUser(api, dbh.db);
    const phone = new OfflinePhone(alice.headers);
    const workoutId = phone.startWorkout("Alice's legs");
    const setId = phone.logSet(workoutId, await libraryId("barbell-back-squat"), 1, 5, 100);
    await phone.sync();
    expect(await myWorkouts(mallory.headers)).toEqual([]);

    // Taking over Alice's workout id fails as a whole...
    const takeover = await upload(mallory.headers, [
      {
        op: "PUT",
        type: "workouts",
        id: workoutId,
        data: { name: "Mine now", started_at: new Date().toISOString() },
      },
    ]);
    expect(takeover.statusCode).toBe(403);
    // ...and changing, deleting or adding to her rows changes nothing.
    const sneaky = await upload(mallory.headers, [
      { op: "PATCH", type: "workout_sets", id: setId, data: { weight_kg: 1 } },
      { op: "DELETE", type: "workout_sets", id: setId },
      { op: "DELETE", type: "workouts", id: workoutId },
      {
        op: "PUT",
        type: "workout_sets",
        id: v7(),
        data: {
          workout_id: workoutId,
          exercise_id: await libraryId("leg-press"),
          position: 2,
          reps: 1,
        },
      },
    ]);
    expect(sneaky.json()).toMatchObject({ applied: 0, skipped: 4 });
    const [saved] = await myWorkouts(alice.headers);
    expect(saved).toMatchObject({
      name: "Alice's legs",
      sets: [expect.objectContaining({ weightKg: 100 })],
    });
    // Nor can anyone edit the shared library through sync.
    const library = await upload(mallory.headers, [
      {
        op: "PATCH",
        type: "exercises",
        id: await libraryId("leg-press"),
        data: { name: "Hacked" },
      },
    ]);
    expect(library.json()).toMatchObject({ applied: 0, skipped: 1 });
  });

  it("rejects a batch with an unknown table or a bad value, applying none of it", async () => {
    const me = await signedInUser(api, dbh.db);
    const phone = new OfflinePhone(me.headers);
    const workoutId = phone.startWorkout("Back");
    phone.logSet(workoutId, await libraryId("barbell-deadlift"), 1, 5, -20);
    const bad = await upload(me.headers, phone.queue);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().detail).toContain("Operation 1");
    const unknown = await upload(me.headers, [{ op: "PUT", type: "users", id: v7(), data: {} }]);
    expect(unknown.statusCode).toBe(400);
    expect(await myWorkouts(me.headers)).toEqual([]);
    const [set] = await dbh.db
      .select()
      .from(workoutSets)
      .where(eq(workoutSets.workoutId, workoutId));
    expect(set).toBeUndefined();
  });
});

describe("sync service sign-in", () => {
  it("publishes the key that verifies the app's access tokens", async () => {
    const me = await signedInUser(api, dbh.db);
    const res = await api.inject({ method: "GET", url: "/v1/auth/jwks" });
    expect(res.statusCode).toBe(200);
    const jwks = res.json() as { keys: { kid: string; d?: string }[] };
    expect(jwks.keys[0]?.d).toBeUndefined();
    expect(jwks.keys[0]?.kid).toBe(decodeProtectedHeader(me.accessToken).kid);
    const { payload } = await jwtVerify(me.accessToken, createLocalJWKSet(jwks as never), {
      issuer: testEnv().JWT_ISSUER,
      audience: testEnv().JWT_AUDIENCE,
    });
    expect(payload.sub).toBe(me.user.id);
  });
});

describe("personal records", () => {
  type Record = { exerciseName: string; kind: string; value: number; setId: string };

  async function records(headers: Headers) {
    const res = await api.inject({ method: "GET", url: "/v1/me/personal-records", headers });
    expect(res.statusCode).toBe(200);
    return Object.fromEntries((res.json() as Record[]).map((r) => [r.kind, r.value]));
  }

  async function celebrations(userId: string) {
    const rows = await dbh.db
      .select({ payload: outboxEvents.payload })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.type, "training.personal_record_set"),
          sql`${outboxEvents.payload}->>'userId' = ${userId}`,
        ),
      );
    return rows.map((r) => r.payload as { kind: string; value: number; previous: number | null });
  }

  it("are found when sets sync, beaten by better sets and announced once per new best", async () => {
    const me = await signedInUser(api, dbh.db);
    const other = await signedInUser(api, dbh.db);
    const bench = await libraryId("barbell-bench-press");
    const phone = new OfflinePhone(me.headers);

    const monday = phone.startWorkout("Monday");
    phone.record({
      op: "PUT",
      type: "workout_sets",
      id: v7(),
      data: {
        workout_id: monday,
        exercise_id: bench,
        position: 0,
        kind: "warmup",
        reps: 1,
        weight_kg: 100,
        completed_at: new Date().toISOString(),
      },
    });
    phone.logSet(monday, bench, 1, 8, 60);
    phone.logSet(monday, bench, 2, 8, 62.5);
    const first = await phone.sync();
    expect(await records(me.headers)).toEqual({
      max_weight: 62.5,
      est_1rm: 79.17,
      best_set_volume: 500,
    });
    expect(await celebrations(me.user.id)).toHaveLength(3);

    const thursday = phone.startWorkout("Thursday");
    phone.logSet(thursday, bench, 1, 5, 70);
    await phone.sync();
    expect(await records(me.headers)).toEqual({
      max_weight: 70,
      est_1rm: 81.67,
      best_set_volume: 500,
    });
    const beaten = (await celebrations(me.user.id)).slice(3);
    expect(beaten).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "max_weight", value: 70, previous: 62.5 }),
        expect.objectContaining({ kind: "est_1rm", value: 81.67, previous: 79.17 }),
      ]),
    );
    expect(beaten).toHaveLength(2);

    // A retried upload changes nothing and announces nothing.
    await upload(me.headers, first.sent);
    expect(await celebrations(me.user.id)).toHaveLength(5);

    // Deleting Thursday's workout puts Monday's records back, without announcing them again.
    phone.record({ op: "DELETE", type: "workouts", id: thursday });
    await phone.sync();
    expect(await records(me.headers)).toEqual({
      max_weight: 62.5,
      est_1rm: 79.17,
      best_set_volume: 500,
    });
    expect(await celebrations(me.user.id)).toHaveLength(5);

    expect(await records(other.headers)).toEqual({});
  });
});
