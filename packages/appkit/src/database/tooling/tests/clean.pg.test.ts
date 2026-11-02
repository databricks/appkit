import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { inTransaction } from "../../migrations/apply";
import { cleanStatements, readCascadeDependents } from "../clean";

// The clean SQL against a real server, as a superuser that may create
// databases and roles, e.g. APPKIT_TEST_PG_URL=postgres://localhost:5432/postgres
const url = process.env.APPKIT_TEST_PG_URL;

async function clean(pool: Pool, schemaName: string): Promise<string[]> {
  const client = await pool.connect();
  try {
    return await inTransaction(client, async () => {
      const dependents = await readCascadeDependents(client, schemaName);
      for (const statement of cleanStatements(schemaName)) {
        await client.query(statement);
      }
      return dependents;
    });
  } finally {
    client.release();
  }
}

async function names(pool: Pool, sql: string): Promise<string[]> {
  const { rows } = await pool.query<{ name: string }>(sql);
  return rows.map((row) => row.name);
}

describe.skipIf(!url)("clean against Postgres", () => {
  const suffix = randomUUID().slice(0, 8);

  describe("an app schema", () => {
    const app = `appkit_clean_${suffix}`;
    const other = `appkit_reporting_${suffix}`;
    let pool: Pool;

    beforeAll(async () => {
      pool = new Pool({ connectionString: url, max: 1 });
      await pool.query(`
        create schema "${app}";
        create type "${app}".kind as enum ('a', 'b');
        create table "${app}".notes (id integer primary key, kind "${app}".kind);
        create table "${app}".__drizzle_migrations (id serial primary key);
        create schema "${other}";
        create view "${other}".recent as select id from "${app}".notes;
        create table "${other}".refs (id integer primary key, note_id integer constraint refs_note_fk references "${app}".notes (id));
        create table "${other}".tagged (id integer primary key, kind "${app}".kind);
      `);
    });
    afterAll(async () => {
      await pool.query(`drop schema if exists "${app}" cascade`);
      await pool.query(`drop schema if exists "${other}" cascade`);
      await pool.end();
    });

    test("reports what CASCADE drops outside the schema, then drops the schema and only those", async () => {
      const dependents = await clean(pool, app);

      expect(dependents).toEqual([
        `column kind of table ${other}.tagged`,
        `constraint refs_note_fk on table ${other}.refs`,
        `view ${other}.recent`,
      ]);
      expect(
        await names(
          pool,
          `select nspname as name from pg_namespace where nspname = '${app}'`,
        ),
      ).toEqual([]);
      expect(
        await names(
          pool,
          `select relname as name from pg_class where relnamespace = '"${other}"'::regnamespace and relkind in ('r', 'v') order by 1`,
        ),
      ).toEqual(["refs", "tagged"]);
    });
  });

  describe("schema public", () => {
    const database = `appkit_clean_${suffix}`;
    const role = `appkit_other_${suffix}`;
    let admin: Pool;
    let pool: Pool;

    beforeAll(async () => {
      admin = new Pool({ connectionString: url, max: 1 });
      await admin.query(`create database "${database}"`);
      await admin.query(`create role "${role}"`);
      const scratch = new URL(url as string);
      scratch.pathname = `/${database}`;
      pool = new Pool({ connectionString: scratch.toString(), max: 1 });
      await pool.query(`
        create extension citext;
        create extension tablefunc;
        create type public.kind as enum ('a', 'b');
        create domain public.positive as integer check (value > 0);
        create type public.pair as (a integer, b integer);
        create table public.notes (id integer primary key, body citext, kind public.kind);
        create table public.__drizzle_migrations (id serial primary key);
        create function public.touch() returns integer language sql as 'select 1';
        create aggregate public.total(integer) (sfunc = int4pl, stype = integer);
        create aggregate public.tally(*) (sfunc = int8inc, stype = bigint, initcond = '0');
        grant select on public.notes to "${role}";
        grant create on schema public to "${role}";
        set role "${role}";
        create view public.their_view as select id from public.notes;
        reset role;
      `);
    });
    afterAll(async () => {
      await pool.end();
      await admin.query(`drop database if exists "${database}"`);
      await admin.query(`drop role if exists "${role}"`);
      await admin.end();
    });

    test("drops the role's own objects and keeps the extensions' and other roles' objects it does not depend on", async () => {
      const extensionTypes = await names(
        pool,
        `select typname as name from pg_type t join pg_depend d on d.objid = t.oid and d.classid = 'pg_type'::regclass and d.deptype = 'e' order by 1`,
      );
      expect(extensionTypes).toContain("citext");
      expect(extensionTypes).toContain("tablefunc_crosstab_2");

      const dependents = await clean(pool, "public");

      expect(dependents).toEqual(["view their_view"]);
      expect(
        await names(
          pool,
          `select relname as name from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'v', 'S')`,
        ),
      ).toEqual([]);
      expect(
        await names(
          pool,
          `select typname as name from pg_type where typnamespace = 'public'::regnamespace and typname in ('kind', 'positive', 'pair') `,
        ),
      ).toEqual([]);
      expect(
        await names(
          pool,
          `select proname as name from pg_proc where pronamespace = 'public'::regnamespace and proname in ('touch', 'total', 'tally')`,
        ),
      ).toEqual([]);
      expect(
        await names(
          pool,
          `select typname as name from pg_type where typnamespace = 'public'::regnamespace and typname in ('citext', 'tablefunc_crosstab_2') order by 1`,
        ),
      ).toEqual(["citext", "tablefunc_crosstab_2"]);
      expect(
        await names(
          pool,
          `select proname as name from pg_proc where pronamespace = 'public'::regnamespace and proname = 'crosstab' limit 1`,
        ),
      ).toEqual(["crosstab"]);
    });
  });
});
