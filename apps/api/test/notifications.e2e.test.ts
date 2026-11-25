import { createDb, withTenant, type DbHandle } from "@gym/db";
import { eq, sql } from "@gym/db/orm";
import { members, notifications, pushDevices } from "@gym/db/schema";
import type { Channel, MessageKey } from "@gym/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import {
  SendError,
  type ChannelAdapter,
  type Outgoing,
  type Recipient,
} from "../src/notifications/channels";
import { notify, runNotificationDelivery } from "../src/notifications/delivery";
import { gymWithMember, signedInUser, testEnv } from "./helpers";

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

/** A stand-in provider that records what it sends, can be switched off, and can report dead push tokens. */
class FakeChannel implements ChannelAdapter {
  sent: { to: string; key: MessageKey; body: string }[] = [];
  failing = false;
  deadTokens: string[] = [];
  constructor(readonly channel: Channel) {}

  reaches(r: Recipient) {
    if (this.channel === "push") return r.pushTokens.length > 0;
    return (this.channel === "email" ? r.email : r.phone) !== null;
  }

  async send(r: Recipient, { key, message }: Outgoing) {
    if (this.failing) throw new SendError(`${this.channel} is down`, this.deadTokens);
    const to =
      this.channel === "push"
        ? r.pushTokens.join(",")
        : this.channel === "email"
          ? r.email
          : r.phone;
    this.sent.push({ to: to ?? "", key, body: message.body });
    return { providerId: `${this.channel}-${this.sent.length}`, deadTokens: this.deadTokens };
  }
}

const fakes = () => {
  const c = {
    push: new FakeChannel("push"),
    whatsapp: new FakeChannel("whatsapp"),
    sms: new FakeChannel("sms"),
    email: new FakeChannel("email"),
  };
  return { ...c, all: [c.push, c.whatsapp, c.sms, c.email] };
};
const options = { perGym: 100, maxAttempts: 3, retryMs: 15 * 60_000 };
const randomPhone = () => `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

type Gym = Awaited<ReturnType<typeof gymWithMember>>;
const orgOf = (g: Gym) => g.base.split("/").pop() ?? "";

async function memberOf(g: Gym, contact: { phone?: string; email?: string }) {
  const res = await g.call("POST", `${g.base}/members`, {
    name: "Asha",
    homeBranchId: g.branch.id,
    ...contact,
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

let seq = 0;
function queue(g: Gym, memberId: string, extra: { expiresAt?: Date; dedupeKey?: string } = {}) {
  return withTenant(dbh.db, orgOf(g), (tx) =>
    notify(tx, {
      tenantId: orgOf(g),
      memberId,
      key: "inactive",
      vars: { name: "Asha", gym: "Iron Den" },
      dedupeKey: extra.dedupeKey ?? `test:${++seq}`,
      ...(extra.expiresAt && { expiresAt: extra.expiresAt }),
    }),
  );
}

async function rowsOf(g: Gym, memberId: string) {
  return withTenant(dbh.db, orgOf(g), (tx) =>
    tx.select().from(notifications).where(eq(notifications.memberId, memberId)),
  );
}

describe("message delivery", () => {
  it("queues each trigger once, however often it fires", async () => {
    const g = await gymWithMember(api, dbh.db);
    const memberId = await memberOf(g, { phone: randomPhone() });
    expect(await queue(g, memberId, { dedupeKey: "renewal_due:m1:7" })).toBe(true);
    expect(await queue(g, memberId, { dedupeKey: "renewal_due:m1:7" })).toBe(false);
    expect(await rowsOf(g, memberId)).toHaveLength(1);
  });

  it("falls back to the next channel when a provider fails, and records why", async () => {
    const g = await gymWithMember(api, dbh.db);
    const phone = randomPhone();
    const memberId = await memberOf(g, { phone, email: "asha@example.com" });
    await queue(g, memberId);
    const c = fakes();
    c.whatsapp.failing = true;
    await runNotificationDelivery(dbh.db, c.all, options);
    const mine = c.sms.sent.filter((m) => m.to === phone);
    expect(mine).toEqual([expect.objectContaining({ key: "inactive" })]);
    expect(mine[0]?.body).toContain("Iron Den");
    const [row] = await rowsOf(g, memberId);
    expect(row).toMatchObject({ status: "sent", channel: "sms", attempts: 1 });
    expect(row?.lastError).toContain("whatsapp is down");
  });

  it("retries later when every channel fails, then gives up", async () => {
    const g = await gymWithMember(api, dbh.db);
    const memberId = await memberOf(g, { phone: randomPhone() });
    await queue(g, memberId);
    const c = fakes();
    c.whatsapp.failing = c.sms.failing = true;
    const start = new Date();
    await runNotificationDelivery(dbh.db, c.all, options, start);
    let [row] = await rowsOf(g, memberId);
    expect(row).toMatchObject({ status: "pending", attempts: 1 });
    expect(row?.sendAfter.getTime()).toBe(start.getTime() + options.retryMs);

    // Not due yet: nothing happens.
    await runNotificationDelivery(dbh.db, c.all, options, new Date(start.getTime() + 60_000));
    [row] = await rowsOf(g, memberId);
    expect(row?.attempts).toBe(1);

    for (let i = 1; i <= 2; i++)
      await runNotificationDelivery(
        dbh.db,
        c.all,
        options,
        new Date(start.getTime() + i * options.retryMs),
      );
    [row] = await rowsOf(g, memberId);
    expect(row).toMatchObject({ status: "failed", attempts: 3 });
    expect(row?.lastError).toBe("whatsapp: whatsapp is down; sms: sms is down");
  });

  it("skips messages that expired, members without contact details and removed members", async () => {
    const g = await gymWithMember(api, dbh.db);
    const late = await memberOf(g, { phone: randomPhone() });
    const removed = await memberOf(g, { phone: randomPhone() });
    await queue(g, late, { expiresAt: new Date(Date.now() - 1000) });
    await queue(g, g.member.id);
    await queue(g, removed);
    await withTenant(dbh.db, orgOf(g), (tx) =>
      tx.update(members).set({ deletedAt: new Date() }).where(eq(members.id, removed)),
    );
    const c = fakes();
    await runNotificationDelivery(dbh.db, c.all, options);
    expect((await rowsOf(g, late))[0]).toMatchObject({
      status: "skipped",
      lastError: expect.stringContaining("expired"),
    });
    expect((await rowsOf(g, g.member.id))[0]).toMatchObject({
      status: "skipped",
      lastError: "no way to reach the member",
    });
    expect((await rowsOf(g, removed))[0]).toMatchObject({
      status: "skipped",
      lastError: "member removed",
    });
  });

  it("sends at most a set number per gym each run, so a busy gym cannot hold up the others", async () => {
    const busy = await gymWithMember(api, dbh.db);
    const quiet = await gymWithMember(api, dbh.db);
    const busyMember = await memberOf(busy, { phone: randomPhone() });
    const quietMember = await memberOf(quiet, { phone: randomPhone() });
    for (let i = 0; i < 5; i++) await queue(busy, busyMember);
    await queue(quiet, quietMember);
    const c = fakes();
    await runNotificationDelivery(dbh.db, c.all, { ...options, perGym: 2 });
    const sent = (rows: { status: string }[]) => rows.filter((r) => r.status === "sent").length;
    expect(sent(await rowsOf(busy, busyMember))).toBe(2);
    expect(sent(await rowsOf(quiet, quietMember))).toBe(1);
    await runNotificationDelivery(dbh.db, c.all, { ...options, perGym: 2 });
    expect(sent(await rowsOf(busy, busyMember))).toBe(4);
  });

  it("is shown to the front desk, and only for their own gym's members", async () => {
    const g = await gymWithMember(api, dbh.db);
    const memberId = await memberOf(g, { phone: randomPhone() });
    await queue(g, memberId);
    const res = await g.call("GET", `${g.base}/members/${memberId}/notifications`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({ key: "inactive", status: "pending", channel: null }),
    ]);
    const other = await gymWithMember(api, dbh.db);
    expect(
      (await other.call("GET", `${other.base}/members/${memberId}/notifications`)).statusCode,
    ).toBe(404);
  });
});

describe("app push notifications", () => {
  async function memberWithApp() {
    const g = await gymWithMember(api, dbh.db);
    const phone = randomPhone();
    const memberId = await memberOf(g, { phone });
    const person = await signedInUser(api, dbh.db, { phone });
    await api.inject({ method: "GET", url: "/v1/me/gyms", headers: person.headers }); // links the member
    const token = `ExponentPushToken[${crypto.randomUUID()}]`;
    const res = await api.inject({
      method: "POST",
      url: "/v1/me/devices",
      headers: person.headers,
      payload: { token, platform: "android" },
    });
    expect(res.statusCode).toBe(201);
    return { g, phone, memberId, person, token, deviceId: (res.json() as { id: string }).id };
  }

  it("go to the member's phone first when they use the app", async () => {
    const { g, phone, memberId, token } = await memberWithApp();
    await queue(g, memberId);
    const c = fakes();
    await runNotificationDelivery(dbh.db, c.all, options);
    expect(c.push.sent).toEqual([expect.objectContaining({ to: token })]);
    expect(c.whatsapp.sent.filter((m) => m.to === phone)).toEqual([]);
  });

  it("stop going to a phone the app was removed from, or that was signed out", async () => {
    const { g, phone, memberId, token, person, deviceId } = await memberWithApp();
    await queue(g, memberId);
    const c = fakes();
    c.push.failing = true;
    c.push.deadTokens = [token];
    await runNotificationDelivery(dbh.db, c.all, options);
    expect(c.whatsapp.sent.filter((m) => m.to === phone)).toHaveLength(1);
    const [device] = await dbh.db.select().from(pushDevices).where(eq(pushDevices.token, token));
    expect(device?.disabledAt).not.toBeNull();

    const removed = await api.inject({
      method: "DELETE",
      url: `/v1/me/devices/${deviceId}`,
      headers: person.headers,
    });
    expect(removed.statusCode).toBe(204);
    expect(await dbh.db.select().from(pushDevices).where(eq(pushDevices.token, token))).toEqual([]);
  });

  it("move a phone's token to whoever signs in on it next", async () => {
    const { token, person } = await memberWithApp();
    const next = await signedInUser(api, dbh.db);
    await api.inject({
      method: "POST",
      url: "/v1/me/devices",
      headers: next.headers,
      payload: { token, platform: "ios" },
    });
    const [device] = await dbh.db.select().from(pushDevices).where(eq(pushDevices.token, token));
    expect(device).toMatchObject({ userId: next.user.id, platform: "ios" });
    expect(device?.userId).not.toBe(person.user.id);
  });

  it("are never readable by another gym", async () => {
    const { memberId } = await memberWithApp();
    const other = await gymWithMember(api, dbh.db);
    const tokens = await withTenant(dbh.db, orgOf(other), (tx) =>
      tx.execute(sql`select app.member_push_tokens(${memberId}) as token`),
    );
    expect(tokens.rows).toEqual([]);
  });
});
