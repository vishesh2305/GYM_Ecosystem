import { createDb, type DbHandle } from "@gym/db";
import { addDays, todayIn } from "@gym/domain";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { createWorker, type WorkerHandle } from "../src/worker/create-worker";
import { gymWithMember, testEnv } from "./helpers";

let api: Awaited<ReturnType<typeof createApp>>["app"];
let dbh: DbHandle;
let worker: WorkerHandle;

beforeAll(async () => {
  ({ app: api } = await createApp(testEnv()));
  dbh = createDb(testEnv().DATABASE_URL);
  worker = await createWorker(testEnv({ OUTBOX_POLL_MS: "50" }));
});
afterAll(async () => {
  await worker.close();
  await api.close();
  await dbh.pool.end();
});

const phone = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;

describe("importing members from a spreadsheet", () => {
  it("creates good rows, reports bad ones row by row, and carries over current plans", async () => {
    const g = await gymWithMember(api, dbh.db);
    await g.plan({ name: "Quarterly", durationUnit: "month", durationCount: 3 });
    await g.call("POST", `${g.base}/branches`, { name: "Baner", city: "Pune" });
    const until = addDays(todayIn("Asia/Kolkata"), 40);
    const p1 = phone();
    const dup = phone();
    const csv = [
      "Name,Phone,Email,Gender,Date of birth,Branch,Plan,Start date,End date",
      `Asha Rao,${p1},asha@example.com,female,1990-05-01,Baner,Quarterly,2026-10-01,${until}`,
      `Vikram Das,${dup},,male,12/03/1988,,,,`,
      `Duplicate Phone,${dup},,,,,,,`,
      `,${phone()},,,,,,,`,
      `Bad Phone,123,,,,,,,`,
      `No Such Branch,${phone()},,,,Andheri,,,`,
      `No Such Plan,${phone()},,,,,Platinum,,`,
      `Bad Date,${phone()},,,31-31-2020,,,,`,
    ].join("\n");

    const res = await g.call("POST", `${g.base}/member-imports`, {
      fileName: "members.csv",
      csv,
      defaultBranchId: g.branch.id,
    });
    expect(res.statusCode).toBe(202);
    const importId = res.json().id;

    let report: {
      status: string;
      createdCount: number;
      failedCount: number;
      totalRows: number;
      errors: { row: number; message: string }[];
    } = res.json();
    await vi.waitFor(
      async () => {
        report = (await g.call("GET", `${g.base}/member-imports/${importId}`)).json();
        expect(report.status).toBe("done");
      },
      { timeout: 15_000, interval: 100 },
    );
    expect(report).toMatchObject({ totalRows: 8, createdCount: 2, failedCount: 6 });
    expect(report.errors.map((e) => e.row)).toEqual([4, 5, 6, 7, 8, 9]);
    expect(report.errors.find((e) => e.row === 4)?.message).toMatch(/already/);
    expect(report.errors.find((e) => e.row === 7)?.message).toMatch(/branch/i);
    expect(report.errors.find((e) => e.row === 8)?.message).toMatch(/plan/i);

    const found = (await g.call("GET", `${g.base}/members?q=Asha`)).json().items[0];
    expect(found).toMatchObject({
      name: "Asha Rao",
      phone: `+91${p1}`,
      source: "import",
      dateOfBirth: "1990-05-01",
    });
    const ms = (await g.call("GET", `${g.base}/members/${found.id}/memberships`)).json();
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ planName: "Quarterly", status: "active", endDate: until });

    const vikram = (await g.call("GET", `${g.base}/members?q=Vikram`)).json().items[0];
    expect(vikram).toMatchObject({ dateOfBirth: "1988-03-12", homeBranchId: g.branch.id });
  });

  it("rejects files with too many rows or without a name column", async () => {
    const g = await gymWithMember(api, dbh.db);
    const header = "Name,Phone\n";
    const huge = header + Array.from({ length: 10_001 }, (_, i) => `M${i},`).join("\n");
    expect(
      (
        await g.call("POST", `${g.base}/member-imports`, {
          fileName: "x.csv",
          csv: huge,
          defaultBranchId: g.branch.id,
        })
      ).statusCode,
    ).toBe(400);
    const noName = await g.call("POST", `${g.base}/member-imports`, {
      fileName: "x.csv",
      csv: "Phone\n9000000000",
      defaultBranchId: g.branch.id,
    });
    expect(noName.statusCode).toBe(400);
    expect(noName.json().detail).toMatch(/Name/);
  });
});
