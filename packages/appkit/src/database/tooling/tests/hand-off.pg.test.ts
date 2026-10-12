import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { readRoleBlockers } from "../hand-off";

// The pg_shdepend query against a real server, as a superuser that may create
// databases and roles, e.g. APPKIT_TEST_PG_URL=postgres://localhost:5432/postgres
const url = process.env.APPKIT_TEST_PG_URL;

function databaseUrl(database: string): string {
  const next = new URL(url as string);
  next.pathname = `/${database}`;
  return next.toString();
}

describe.skipIf(!url)("readRoleBlockers against Postgres", () => {
  const suffix = randomUUID().slice(0, 8);
  const role = `appkit_sp_${suffix}`;
  const main = `appkit_main_${suffix}`;
  const other = `appkit_other_${suffix}`;
  const owned = `appkit_owned_${suffix}`;
  let admin: Pool;
  let mainPool: Pool;
  let otherPool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`create role "${role}"`);
    await admin.query(`create database "${main}"`);
    await admin.query(`create database "${other}"`);
    await admin.query(`create database "${owned}" owner "${role}"`);
    mainPool = new Pool({ connectionString: databaseUrl(main), max: 1 });
    otherPool = new Pool({ connectionString: databaseUrl(other), max: 1 });
    await mainPool.query(`
      create schema app authorization "${role}";
      create table app.notes (id integer primary key);
      alter table app.notes owner to "${role}";
      create table public.shared (id integer);
      grant select on public.shared to "${role}";
    `);
    await otherPool.query(`
      create table public.reports (id integer);
      alter table public.reports owner to "${role}";
    `);
  });
  afterAll(async () => {
    await mainPool.end();
    await otherPool.end();
    for (const database of [main, other, owned]) {
      await admin.query(`drop database if exists "${database}"`);
    }
    await admin.query(`drop role if exists "${role}"`);
    await admin.end();
  });

  test("lists what outlives a reassign in this database: other databases' objects, shared objects, and grants", async () => {
    const blockers = await readRoleBlockers(mainPool, role);

    expect(blockers).toEqual(
      [
        { database: "", count: 1 },
        { database: main, count: 1 },
        { database: other, count: 1 },
      ].sort((a, b) => a.database.localeCompare(b.database)),
    );
  });

  test("a role without dependencies has no blockers", async () => {
    await expect(
      readRoleBlockers(mainPool, `appkit_missing_${suffix}`),
    ).resolves.toEqual([]);
  });
});
