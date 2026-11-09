import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { defineSchema, id } from "../../schema-builder";
import {
  catalogSqlOf,
  detectTablesLeftInPublic,
  locateTables,
} from "../tables-left-in-public";

// A real server, for what a fake cannot show: the catalog query, the array
// parameter binding through pg, and the relkind filter. Point it at a scratch
// database, e.g. APPKIT_TEST_PG_URL=postgres://localhost:5432/postgres
const url = process.env.APPKIT_TEST_PG_URL;

describe.skipIf(!url)("tables left in public, against Postgres", () => {
  let pool: Pool;
  const cleanup: string[] = [];
  const unique = () => `appkit_test_${randomUUID().slice(0, 8)}`;

  beforeAll(() => {
    pool = new Pool({ connectionString: url, max: 2 });
  });
  afterAll(async () => {
    await pool.end();
  });
  afterEach(async () => {
    for (const statement of cleanup.splice(0)) await pool.query(statement);
  });

  test("finds tables in the target schema and in public, skipping views", async () => {
    const schema = unique();
    const [here, there, view] = [unique(), unique(), unique()];
    cleanup.push(
      `drop schema if exists "${schema}" cascade`,
      `drop table if exists public."${there}"`,
      `drop view if exists public."${view}"`,
    );
    await pool.query(`create schema "${schema}"`);
    await pool.query(`create table "${schema}"."${here}" (id int)`);
    await pool.query(`create table public."${there}" (id int)`);
    await pool.query(`create view public."${view}" as select 1 as id`);

    const placement = await locateTables(catalogSqlOf(pool), schema, [
      here,
      there,
      view,
      "never_created",
    ]);

    expect(placement).toEqual({ inSchema: [here], inPublic: [there] });
  });

  test("an app table still in public with nothing in app is refused; once app has it, it is not", async () => {
    const table = unique();
    cleanup.push(
      `drop table if exists public."${table}"`,
      `drop table if exists app."${table}"`,
    );
    const schema = defineSchema(({ table: declare }) => ({
      [table]: declare(table, { id: id() }),
    }));
    await pool.query(`create table public."${table}" (id int)`);

    const refused = await detectTablesLeftInPublic(catalogSqlOf(pool), schema);
    await pool.query(`create schema if not exists app`);
    await pool.query(`create table app."${table}" (id int)`);
    const allowed = await detectTablesLeftInPublic(catalogSqlOf(pool), schema);

    expect(refused).toContain(`public has ${table}`);
    expect(allowed).toBeUndefined();
  });
});
