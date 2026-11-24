// Runs before each test file: gives the file its own database (copied from the migrated template database)
// and its own queue prefix, so test files running in parallel never see each other's data or jobs.
import { randomUUID } from "node:crypto";
import { createDb } from "@gym/db";
import { inject } from "vitest";

const template = new URL(inject("databaseUrl"));
const name = `t_${randomUUID().replaceAll("-", "")}`;
const admin = new URL(template);
admin.pathname = "/postgres";

const { pool } = createDb(admin.toString(), 1);
await pool.query(`CREATE DATABASE "${name}" TEMPLATE "${template.pathname.slice(1)}"`);
await pool.end();

const own = new URL(template);
own.pathname = `/${name}`;
Object.assign(globalThis, { __testDatabaseUrl: own.toString(), __testQueuePrefix: name });
