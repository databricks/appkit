import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { readOwnedOutsideSchema, readRoleDependencies } from "../hand-off";

// The pg_shdepend query against a real server, as a superuser that may create
// databases and roles, e.g. APPKIT_TEST_PG_URL=postgres://localhost:5432/postgres
const url = process.env.APPKIT_TEST_PG_URL;

function databaseUrl(database: string): string {
  const next = new URL(url as string);
  next.pathname = `/${database}`;
  return next.toString();
}

describe.skipIf(!url)("readRoleDependencies against Postgres", () => {
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

  test("what outlives a reassign in this database: other databases' objects and shared objects it owns, apart from its grants", async () => {
    await expect(readRoleDependencies(mainPool, role)).resolves.toEqual({
      owned: [
        { database: "", count: 1 },
        { database: other, count: 1 },
      ],
      granted: [{ database: main, count: 1 }],
    });
  });

  test("a role without dependencies has none", async () => {
    await expect(
      readRoleDependencies(mainPool, `appkit_missing_${suffix}`),
    ).resolves.toEqual({ owned: [], granted: [] });
  });

  test("what the role owns in this database outside the app schema: nothing while it only owns the schema and its tables", async () => {
    await expect(
      readOwnedOutsideSchema(mainPool, role, "app"),
    ).resolves.toEqual([]);
  });

  test("lists the role's tables, types, routines and schemas elsewhere, not grants, system objects or other databases", async () => {
    await mainPool.query(`
      alter table public.shared owner to "${role}";
      create type public.shared_kind as enum ('a');
      alter type public.shared_kind owner to "${role}";
      create function public.shared_fn(integer) returns integer language sql as 'select $1';
      alter function public.shared_fn(integer) owner to "${role}";
      create schema reports authorization "${role}";
      create table reports.daily (id integer primary key);
      alter table reports.daily owner to "${role}";
    `);
    try {
      await expect(
        readOwnedOutsideSchema(mainPool, role, "app"),
      ).resolves.toEqual([
        "function public.shared_fn(integer)",
        "schema reports",
        "table public.shared",
        "table reports.daily",
        "type public.shared_kind",
      ]);
    } finally {
      await mainPool.query(`
        drop schema reports cascade;
        drop function public.shared_fn(integer);
        drop type public.shared_kind;
        alter table public.shared owner to current_user;
      `);
    }
  });

  test("lists an extension the role created, which has no schema", async () => {
    await admin.query(`grant create on database "${main}" to "${role}"`);
    await mainPool.query(`
      set role "${role}";
      create extension pgcrypto schema app;
      reset role;
    `);
    try {
      await expect(
        readOwnedOutsideSchema(mainPool, role, "app"),
      ).resolves.toEqual(["extension pgcrypto"]);
    } finally {
      await mainPool.query("drop extension pgcrypto");
      await admin.query(`revoke create on database "${main}" from "${role}"`);
    }
  });
});
