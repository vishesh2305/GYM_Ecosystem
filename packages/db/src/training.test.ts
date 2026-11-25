import { EQUIPMENT, MUSCLES } from "@gym/domain";
import { eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";
import { createDb, type DbHandle } from "./client";
import { exercises, users } from "./schema";
import { withUser } from "./tenant";

let handle: DbHandle;
let alice: string;
let bob: string;

async function newUser(name: string) {
  const [u] = await handle.db.insert(users).values({ name }).returning();
  if (!u) throw new Error("insert failed");
  return u.id;
}

const ownExercise = (userId: string, name: string) => ({
  userId,
  name,
  primaryMuscle: "chest",
  equipment: "other",
  tracking: "weight_reps" as const,
});

beforeAll(async () => {
  handle = createDb(inject("databaseUrl"));
  [alice, bob] = await Promise.all([newUser("Alice"), newUser("Bob")]);
});
afterAll(async () => {
  await handle.pool.end();
});

describe("exercise library", () => {
  it("is seeded with tagged exercises using only known muscles and equipment", async () => {
    const library = await handle.db.select().from(exercises).where(isNull(exercises.userId));
    expect(library.length).toBeGreaterThanOrEqual(60);
    for (const e of library) {
      expect(e.slug).toMatch(/^[a-z0-9-]+$/);
      expect(MUSCLES).toContain(e.primaryMuscle);
      for (const m of e.secondaryMuscles) expect(MUSCLES).toContain(m);
      expect(EQUIPMENT).toContain(e.equipment);
    }
  });

  it("a person sees the library and their own exercises, never someone else's", async () => {
    await handle.db
      .insert(exercises)
      .values([ownExercise(alice, "Alice's press"), ownExercise(bob, "Bob's press")]);
    const seen = await withUser(handle.db, alice, (tx) => tx.select().from(exercises));
    const names = seen.map((e) => e.name);
    expect(names).toContain("Alice's press");
    expect(names).toContain("Bench Press (Barbell)");
    expect(names).not.toContain("Bob's press");
  });

  it("a person cannot create exercises for someone else or change the shared library", async () => {
    await expect(
      withUser(handle.db, alice, (tx) => tx.insert(exercises).values(ownExercise(bob, "Forged"))),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
    const changed = await withUser(handle.db, alice, (tx) =>
      tx
        .update(exercises)
        .set({ name: "Hijacked" })
        .where(eq(exercises.slug, "barbell-bench-press"))
        .returning(),
    );
    expect(changed).toEqual([]);
  });
});
