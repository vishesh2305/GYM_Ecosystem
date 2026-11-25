import { createDb, withTenant, type DbHandle } from "@gym/db";
import { eq } from "@gym/db/orm";
import { bookings, classSessions, leads } from "@gym/db/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { gymWithMember, randomIp, testEnv } from "./helpers";

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

type Gym = Awaited<ReturnType<typeof gymWithMember>>;
const orgOf = (g: Gym) => g.base.split("/").pop() ?? "";
const keys = (o: object) => Object.keys(o).sort();
const anon = (method: string, url: string, payload?: object, ip = randomIp()) =>
  api.inject({ method, url, remoteAddress: ip, ...(payload && { payload }) });

/** A gym with a published page at a fresh slug, a GSTIN and one paying member (private data that must not leak). */
async function publishedGym() {
  const g = await gymWithMember(api, dbh.db);
  const slug = `iron-den-${Math.floor(Math.random() * 1e9)}`;
  const res = await g.call("PATCH", g.base, {
    slug,
    about: "Strength gym in Kothrud",
    published: true,
    gstin: "27AAPFU0939F1ZV",
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ slug, published: true });
  return { g, slug };
}

describe("public gym page", () => {
  it("shows only what a gym would put on its website, and may be cached", async () => {
    const { g, slug } = await publishedGym();
    await g.plan({ name: "Monthly", pricePaise: 150_000 });
    const hidden = await g.plan({ name: "Staff special", pricePaise: 1 });
    await g.call("PATCH", `${g.base}/plans/${hidden.id}`, { active: false });

    const res = await anon("GET", `/v1/public/gyms/${slug}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=60, s-maxage=300");
    const page = res.json();
    // The exact shape: adding a field to the public page must be a deliberate change to this test.
    expect(keys(page)).toEqual(["about", "branches", "name", "plans", "slug", "timezone"]);
    expect(keys(page.branches[0])).toEqual([
      "addressLine",
      "city",
      "id",
      "name",
      "phone",
      "postalCode",
      "state",
    ]);
    expect(keys(page.plans[0])).toEqual([
      "branchIds",
      "description",
      "durationCount",
      "durationUnit",
      "gstRateBps",
      "id",
      "isTrial",
      "joiningFeePaise",
      "name",
      "pricePaise",
    ]);
    expect(page).toMatchObject({ name: "Test Gym", slug, about: "Strength gym in Kothrud" });
    expect(page.plans.map((p: { name: string }) => p.name)).toEqual(["Monthly"]);
    const text = res.body;
    for (const secret of ["27AAPFU0939F1ZV", "Member", g.owner.user.id, orgOf(g)])
      expect(text).not.toContain(secret);
  });

  it("does not exist until it is published, and slugs are unique", async () => {
    const g = await gymWithMember(api, dbh.db);
    expect((await g.call("PATCH", g.base, { published: true })).statusCode).toBe(400);
    const slug = `quiet-gym-${Math.floor(Math.random() * 1e9)}`;
    await g.call("PATCH", g.base, { slug });
    expect((await anon("GET", `/v1/public/gyms/${slug}`)).statusCode).toBe(404);
    expect((await anon("GET", "/v1/public/gyms/no-such-gym")).statusCode).toBe(404);
    const { slug: taken } = await publishedGym();
    expect((await g.call("PATCH", g.base, { slug: taken })).statusCode).toBe(409);
    expect((await g.call("PATCH", g.base, { slug: "Bad Slug!" })).statusCode).toBe(400);
  });
});

describe("public class schedule", () => {
  it("lists upcoming classes with places left, and nothing about who booked or teaches", async () => {
    const { g, slug } = await publishedGym();
    const orgId = orgOf(g);
    const session = (name: string, inHours: number, extra: object = {}) => ({
      tenantId: orgId,
      branchId: g.branch.id,
      kind: "class" as const,
      name,
      startsAt: new Date(Date.now() + inHours * 3_600_000),
      endsAt: new Date(Date.now() + (inHours + 1) * 3_600_000),
      capacity: 10,
      cancelWindowMinutes: 60,
      ...extra,
    });
    const rows = await withTenant(dbh.db, orgId, (tx) =>
      tx
        .insert(classSessions)
        .values([
          session("Yoga", 5),
          session("PT with Ravi", 6, { kind: "pt", capacity: 1 }),
          session("Cancelled spin", 7, { status: "cancelled" }),
          session("Next month", 24 * 30),
        ])
        .returning(),
    );
    const yoga = rows.find((r) => r.name === "Yoga");
    await withTenant(dbh.db, orgId, (tx) =>
      tx.insert(bookings).values({
        tenantId: orgId,
        sessionId: yoga?.id ?? "",
        memberId: g.member.id,
        status: "confirmed",
      }),
    );

    const res = await anon("GET", `/v1/public/gyms/${slug}/schedule`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toContain("public");
    const list = res.json() as { name: string; placesLeft: number }[];
    expect(list.map((s) => [s.name, s.placesLeft])).toEqual([["Yoga", 9]]);
    expect(keys(list[0] ?? {})).toEqual([
      "branchId",
      "endsAt",
      "id",
      "name",
      "placesLeft",
      "room",
      "startsAt",
    ]);
    expect(res.body).not.toContain(g.member.id);
  });
});

describe("enquiry form", () => {
  it("turns an enquiry into one website lead, however often it is sent", async () => {
    const { g, slug } = await publishedGym();
    const form = {
      name: "Neha",
      phone: "9876501234",
      branchId: g.branch.id,
      interest: "Zumba",
      consent: true,
    };
    const first = await anon("POST", `/v1/public/gyms/${slug}/enquiries`, form);
    const again = await anon("POST", `/v1/public/gyms/${slug}/enquiries`, {
      ...form,
      interest: "Zumba, evenings",
    });
    expect(first.statusCode).toBe(202);
    expect(again.json()).toEqual(first.json());

    const rows = await withTenant(dbh.db, orgOf(g), (tx) =>
      tx.select().from(leads).where(eq(leads.phone, "+919876501234")),
    );
    expect(rows).toEqual([
      expect.objectContaining({
        source: "website",
        stage: "new",
        interest: "Zumba, evenings",
        consentAt: expect.any(Date),
      }),
    ]);
  });

  it("needs consent, a real branch of that gym and a published page", async () => {
    const { g, slug } = await publishedGym();
    const other = await publishedGym();
    const form = { name: "Neha", phone: "9876501235", branchId: g.branch.id, consent: true };
    expect(
      (await anon("POST", `/v1/public/gyms/${slug}/enquiries`, { ...form, consent: false }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await anon("POST", `/v1/public/gyms/${slug}/enquiries`, {
          ...form,
          branchId: other.g.branch.id,
        })
      ).statusCode,
    ).toBe(404);
    await g.call("PATCH", g.base, { published: false });
    expect((await anon("POST", `/v1/public/gyms/${slug}/enquiries`, form)).statusCode).toBe(404);
  });

  it("is rate limited per visitor", async () => {
    const { g, slug } = await publishedGym();
    const ip = randomIp();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await anon(
        "POST",
        `/v1/public/gyms/${slug}/enquiries`,
        { name: "Spam", phone: `98765${String(10000 + i)}`, branchId: g.branch.id, consent: true },
        ip,
      );
      codes.push(res.statusCode);
    }
    expect(codes).toEqual([202, 202, 202, 202, 202, 429]);
  });
});
