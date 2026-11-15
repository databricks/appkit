import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

const { withBranchPool } = vi.hoisted(() => ({ withBranchPool: vi.fn() }));

vi.mock("../context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../context")>()),
  withBranchPool,
}));

import type { DbContext } from "../context";
import { devBranchId } from "../naming";
import { FORK_COPY_TAG } from "../schema-state";
import { runVerify } from "../verify";

const url = process.env.APPKIT_TEST_PG_URL;
const builder = path.resolve(
  import.meta.dirname,
  "../../schema-builder/index.ts",
);
const USER = "alice@example.com";
const BRANCH = `projects/p/branches/${devBranchId(USER)}`;
const PRODUCTION = "projects/p/branches/production";
const MIGRATION = { tag: "0000_migration", when: 1700000000000 };

describe.skipIf(!url)("runVerify against Postgres", () => {
  const suffix = randomUUID().slice(0, 8);
  const schema = `verify_${suffix}`;
  const sp = `verify_sp_${suffix}`;
  const journal = `"${schema}".__drizzle_migrations`;
  let admin: Pool;
  let ctx: DbContext;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url, max: 1 });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "appkit-verify-pg-"));
    const file = path.join(root, "config/database/schema.ts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `import { defineSchema, id, text } from ${JSON.stringify(builder)};
       export const schema = defineSchema(
         ({ table }) => ({ notes: table("notes", { id: id(), body: text() }) }),
         { schemaName: ${JSON.stringify(schema)} },
       );`,
    );
    const migrations = path.join(root, "config/database/migrations");
    fs.mkdirSync(path.join(migrations, "meta"), { recursive: true });
    const sql = `create table "${schema}".notes (id serial primary key, body text);\n`;
    fs.writeFileSync(path.join(migrations, `${MIGRATION.tag}.sql`), sql);
    fs.writeFileSync(
      path.join(migrations, "meta/_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [
          {
            idx: 0,
            version: "7",
            when: MIGRATION.when,
            tag: MIGRATION.tag,
            breakpoints: true,
          },
        ],
      }),
    );
    await admin.query(`
      create role "${sp}" nologin;
      create schema "${schema}" authorization "${sp}";
      set role "${sp}";
      ${sql}
      create table ${journal} (id serial primary key, hash text not null, created_at bigint);
      reset role;
    `);
    await admin.query(
      `insert into ${journal} (hash, created_at) values ($1, $2)`,
      [createHash("sha256").update(sql).digest("hex"), MIGRATION.when],
    );
    ctx = {
      root,
      env: {
        PGHOST: "ep-1.example.com",
        PGDATABASE: "databricks_postgres",
        LAKEBASE_ENDPOINT: `${BRANCH}/endpoints/primary`,
        PGUSER: USER,
      },
      workspace: () => {
        throw new Error("no workspace calls expected");
      },
      api: () => {
        throw new Error("no Lakebase API calls expected");
      },
    };
    withBranchPool.mockImplementation(
      async (_ctx, fn: (pool: Pool) => Promise<unknown>) => {
        const pool = new Pool({ connectionString: url, max: 2 });
        try {
          return await fn(pool);
        } finally {
          await pool.end();
        }
      },
    );
  });

  afterAll(async () => {
    await admin.query(`
      drop schema if exists "${schema}" cascade;
      drop owned by "${sp}";
      drop role if exists "${sp}";
    `);
    await admin.end();
    fs.rmSync(ctx.root, { recursive: true, force: true });
  });

  test("on a deploy branch, the app schema its service principal owns is not a fork copy", async () => {
    const deploy = {
      ...ctx,
      env: { ...ctx.env, LAKEBASE_ENDPOINT: `${PRODUCTION}/endpoints/primary` },
    };

    expect(await runVerify(deploy)).toEqual({
      kind: "local",
      branch: PRODUCTION,
      schemaProblems: [],
      schemaAdvice: null,
      pendingMigrations: [],
      strandedMigrations: [],
      editedMigrations: [],
      unknownMigrations: 0,
      forkCopy: null,
      ok: true,
    });
  });

  test("the fork's untouched copy, which the service principal still owns, is reported with the init advice", async () => {
    expect(await runVerify(ctx)).toEqual({
      kind: "local",
      branch: BRANCH,
      schemaProblems: [],
      schemaAdvice: null,
      pendingMigrations: [],
      strandedMigrations: [],
      editedMigrations: [],
      unknownMigrations: 0,
      forkCopy: `${devBranchId(USER)} still holds the rows the fork copied into schema "${schema}", which "${sp}" still owns. Run \`appkit db init\` to rebuild it from the committed migrations, or \`appkit db init --schema migrate\` to keep them.`,
      ok: false,
    });
  });

  test("handed to you and tagged by init, the copy is reported as awaiting its rebuild, and the tag is not an unknown migration", async () => {
    await admin.query(`reassign owned by "${sp}" to current_user`);
    await admin.query(
      `insert into ${journal} (hash, created_at) values ($1, 0)`,
      [FORK_COPY_TAG],
    );

    expect(await runVerify(ctx)).toEqual({
      kind: "local",
      branch: BRANCH,
      schemaProblems: [],
      schemaAdvice: null,
      pendingMigrations: [],
      strandedMigrations: [],
      editedMigrations: [],
      unknownMigrations: 0,
      forkCopy: `${devBranchId(USER)} still holds the rows the fork copied into schema "${schema}", and its rebuild did not finish. Run \`appkit db init\` to rebuild it from the committed migrations, or \`appkit db init --schema migrate\` to keep them.`,
      ok: false,
    });
  });

  test("with the tag gone, the same branch verifies", async () => {
    await admin.query(`delete from ${journal} where hash = $1`, [
      FORK_COPY_TAG,
    ]);

    expect(await runVerify(ctx)).toMatchObject({
      unknownMigrations: 0,
      forkCopy: null,
      ok: true,
    });
  });
});
