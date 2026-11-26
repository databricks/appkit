import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  FORK_COPY_TAG,
  isForkCopy,
  readSchemaState,
  tagForkCopy,
  untagForkCopy,
} from "../schema-state";

// The tag and the state read against a real server, with Lakebase's roles
// modelled. The app's service principal owns the fork's copy, and you connect
// as a role that inherits pg_read_all_data and pg_write_all_data, as a member
// of DATABRICKS_SUPERUSER does. APPKIT_TEST_PG_URL is a superuser URL, e.g.
// postgres://localhost:5432/postgres
const url = process.env.APPKIT_TEST_PG_URL;

function asRole(role: string, password: string): string {
  const next = new URL(url as string);
  next.username = role;
  next.password = password;
  return next.toString();
}

describe.skipIf(!url)("the fork-copy tag against Postgres", () => {
  const suffix = randomUUID().slice(0, 8);
  const sp = `appkit_sp_${suffix}`;
  const superuser = `appkit_dbx_${suffix}`;
  const dev = `appkit_dev_${suffix}`;
  const app = `app_${suffix}`;
  const bare = `bare_${suffix}`;
  const shared = `shared_${suffix}`;
  const other = `appkit_other_${suffix}`;
  const foreign = `foreign_${suffix}`;
  let admin: Pool;
  let me: Pool;

  const journalRows = async (schema = app) =>
    (
      await admin.query<{ hash: string; created_at: string }>(
        `select hash, created_at::text from "${schema}".__drizzle_migrations order by id`,
      )
    ).rows;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`
      create role "${sp}" nologin;
      create role "${other}" nologin;
      create role "${superuser}" nologin;
      grant pg_read_all_data, pg_write_all_data to "${superuser}";
      create role "${dev}" login password 'appkit';
      grant "${superuser}" to "${dev}";
      grant create on database ${(await admin.query("select current_database() as db")).rows[0]?.db} to "${sp}";
      create schema "${app}" authorization "${sp}";
      create schema "${bare}" authorization "${sp}";
      create schema "${foreign}" authorization "${sp}";
      create table "${foreign}".__drizzle_migrations (id serial primary key, hash text not null, created_at bigint);
      insert into "${foreign}".__drizzle_migrations (hash, created_at) values ('abc', 1700000000000);
      alter table "${foreign}".__drizzle_migrations owner to "${other}";
      set role "${sp}";
      create table "${app}".notes (id integer primary key, body text);
      insert into "${app}".notes values (1, 'copied');
      create table "${app}".__drizzle_migrations (id serial primary key, hash text not null, created_at bigint);
      insert into "${app}".__drizzle_migrations (hash, created_at) values ('abc', 1700000000000);
      create table "${bare}".notes (id integer primary key);
      reset role;
      create table public."${shared}" (id integer primary key);
      alter table public."${shared}" owner to "${sp}";
    `);
    me = new Pool({ connectionString: asRole(dev, "appkit"), max: 1 });
  });
  afterAll(async () => {
    await me?.end();
    await admin.query(`
      drop schema if exists "${app}" cascade;
      drop schema if exists "${bare}" cascade;
      drop schema if exists "${foreign}" cascade;
      drop table if exists public."${shared}";
      reassign owned by "${sp}" to current_user;
      drop owned by "${sp}";
      drop owned by "${other}";
      drop owned by "${dev}";
      drop role if exists "${dev}";
      drop role if exists "${superuser}";
      drop role if exists "${sp}";
      drop role if exists "${other}";
    `);
    await admin.end();
  });

  test("a schema that does not exist is absent", async () => {
    await expect(readSchemaState(me, `missing_${suffix}`)).resolves.toEqual({
      kind: "absent",
    });
  });

  test("the service principal's copy reads as a copy, and you can tag its journal before any hand-off", async () => {
    await expect(readSchemaState(me, app)).resolves.toEqual({
      kind: "copy",
      owner: sp,
    });
    await expect(isForkCopy(me, app)).resolves.toBe(false);

    await expect(tagForkCopy(me, app)).resolves.toBe(true);
    await expect(tagForkCopy(me, app)).resolves.toBe(true);

    await expect(isForkCopy(me, app)).resolves.toBe(true);
    expect(await journalRows()).toEqual([
      { hash: "abc", created_at: "1700000000000" },
      { hash: FORK_COPY_TAG, created_at: "0" },
    ]);
    await expect(readSchemaState(me, app)).resolves.toEqual({
      kind: "copy",
      owner: sp,
    });
  });

  test("once handed to you, a tagged schema reads as an interrupted rebuild, and untagging makes it yours", async () => {
    await admin.query(`
      alter schema "${app}" owner to "${dev}";
      alter table "${app}".notes owner to "${dev}";
      alter table "${app}".__drizzle_migrations owner to "${dev}";
    `);

    await expect(readSchemaState(me, app)).resolves.toEqual({
      kind: "interrupted-rebuild",
    });

    await untagForkCopy(me, app);
    await expect(readSchemaState(me, app)).resolves.toEqual({ kind: "yours" });
    expect(await journalRows()).toEqual([
      { hash: "abc", created_at: "1700000000000" },
    ]);
    await untagForkCopy(me, app);
  });

  test("a schema without a journal cannot be tagged, and reads as a copy all the same", async () => {
    await expect(tagForkCopy(me, bare)).resolves.toBe(false);
    await expect(isForkCopy(me, bare)).resolves.toBe(false);
    await untagForkCopy(me, bare);
    await expect(readSchemaState(me, bare)).resolves.toEqual({
      kind: "copy",
      owner: sp,
    });
  });

  test("a journal owned by a role you neither are nor inherit, and that does not own the schema, is never written", async () => {
    // pg_write_all_data lets you insert there, so only the trust rule stops the write.
    const before = await journalRows(foreign);
    await expect(tagForkCopy(me, foreign)).resolves.toBe(false);
    expect(await journalRows(foreign)).toEqual(before);

    await admin.query(
      `insert into "${foreign}".__drizzle_migrations (hash, created_at) values ($1, 0)`,
      [FORK_COPY_TAG],
    );
    await untagForkCopy(me, foreign);
    expect(await journalRows(foreign)).toEqual([
      ...before,
      { hash: FORK_COPY_TAG, created_at: "0" },
    ]);
    // Without row-level security a read runs no code of the owner's, so the tag is read.
    await expect(isForkCopy(me, foreign)).resolves.toBe(true);

    // With it, a policy of the owner's would run on the read, so the journal is not read.
    await admin.query(`
      alter table "${foreign}".__drizzle_migrations enable row level security;
      create policy everything on "${foreign}".__drizzle_migrations using (true);
    `);
    await expect(isForkCopy(me, foreign)).resolves.toBe(false);
  });

  test("public is never a copy: it lists what other roles own there", async () => {
    const state = await readSchemaState(me, "public");
    expect(state.kind).toBe("public");
    expect(state.kind === "public" && state.kept).toContain(`table ${shared}`);
  });
});
