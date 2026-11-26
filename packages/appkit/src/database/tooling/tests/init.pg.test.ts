import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

const { withBranchPool } = vi.hoisted(() => ({ withBranchPool: vi.fn() }));

vi.mock("../context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../context")>()),
  withBranchPool,
}));

import { DEFAULT_SCHEMA_FILE } from "../../../plugins/database/load-schema";
import { loadDatabaseSchema } from "../../../type-generator/database";
import { applyPendingMigrations } from "../../migrations/apply";
import { migrationsFolder } from "../../migrations/paths";
import { hashOf } from "../../migrations/tests/fixtures";
import type { DbContext } from "../context";
import { withHistoryLock } from "../history-lock";
import { type InitOptions, runInit } from "../init";
import { IntrospectRefusedError, runIntrospect } from "../introspect";
import type { LakebaseApi } from "../lakebase-api";
import { runMigrate } from "../migrate";
import { generateMigrationFiles } from "../migrations";
import { devBranchId } from "../naming";
import { FORK_COPY_TAG } from "../schema-state";
import { runSeed, SEED_FILE } from "../seed";
import {
  cleanupTempApps,
  databricksYml,
  FakeLakebase,
  fakeContext,
  tempApp,
} from "./fakes";

// init end to end. The Lakebase API is the fake, every SQL step is real. The
// test database models a fork of the deploy branch. The app's service
// principal owns the app schema, and you connect as a role that inherits
// pg_read_all_data and pg_write_all_data, as a member of DATABRICKS_SUPERUSER
// does. APPKIT_TEST_PG_URL is a superuser URL that may create databases and
// roles, e.g. postgres://localhost:5432/postgres
const url = process.env.APPKIT_TEST_PG_URL;

const USER = "alice@example.com";
const P = "projects/p";
const PRODUCTION = `${P}/branches/production`;
const DEV = `${P}/branches/${devBranchId(USER)}`;
const builder = path.resolve(
  import.meta.dirname,
  "../../schema-builder/index.ts",
);

function schemaSource(schemaName: string, table: string): string {
  return `import { defineSchema, id, text } from ${JSON.stringify(builder)};
export const schema = defineSchema(({ table }) => ({ ${table}: table(${JSON.stringify(table)}, { id: id(), body: text() }) }), { schemaName: ${JSON.stringify(schemaName)} });
`;
}

describe.skipIf(!url)("runInit against Postgres", () => {
  const suffix = randomUUID().slice(0, 8);
  const database = `appkit_init_${suffix}`;
  const sp = `appkit_sp_${suffix}`;
  const superuser = `appkit_dbx_${suffix}`;
  const dev = `appkit_dev_${suffix}`;
  const app = `app_${suffix}`;
  let cluster: Pool;
  let admin: Pool;
  let asSp: Pool;
  let asDev: Pool;
  let root: string;
  let publicRoot: string;
  let lakebase: FakeLakebase;
  let api: LakebaseApi;

  const inDatabase = (role: string, password: string) => {
    const next = new URL(url as string);
    next.username = role;
    next.password = password;
    next.pathname = `/${database}`;
    return next.toString();
  };
  const folder = (appRoot: string) => migrationsFolder(appRoot);
  const rows = async (table: string) =>
    (await admin.query<{ body: string }>(`select body from ${table}`)).rows;
  const journal = async (schema: string) =>
    (
      await admin.query<{ hash: string }>(
        `select hash from "${schema}".__drizzle_migrations order by id`,
      )
    ).rows.map((row) => row.hash);
  const ownerOf = async (schema: string) =>
    (
      await admin.query<{ owner: string }>(
        `select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = $1`,
        [schema],
      )
    ).rows[0]?.owner;

  async function generate(appRoot: string) {
    const schema = await loadDatabaseSchema(
      path.join(appRoot, DEFAULT_SCHEMA_FILE),
    );
    await withHistoryLock(appRoot, "migrate", (lock) =>
      generateMigrationFiles(lock, { schema, interactive: false }),
    );
  }

  async function deployed(appRoot: string, schema: string, table: string) {
    await applyPendingMigrations(asSp, {
      migrationsFolder: folder(appRoot),
      schemaName: schema,
    });
    await asSp.query(`insert into ${table} (body) values ('copied')`);
  }

  function project(): FakeLakebase {
    const fake = new FakeLakebase();
    fake.addBranch(PRODUCTION, { default: true });
    fake.addDatabase(PRODUCTION, "databricks-postgres", database);
    fake.addRole(PRODUCTION, "alice", USER, ["DATABRICKS_SUPERUSER"]);
    fake.addRole(PRODUCTION, `dbrx-apps-${sp}`, sp);
    return fake;
  }

  function apiWithRealHandOff(fake: FakeLakebase): LakebaseApi {
    const real = fake.api();
    const deleteRole = real.deleteRole.bind(real);
    real.deleteRole = async (role, options) => {
      await admin.query(`reassign owned by "${sp}" to "${dev}"`);
      await deleteRole(role, options);
    };
    return real;
  }

  function existingDev(fake: FakeLakebase) {
    fake.addBranch(DEV, { source_branch: PRODUCTION });
    fake.addRole(DEV, "alice", USER, ["DATABRICKS_SUPERUSER"]);
  }

  function context(appRoot: string, env: Record<string, string> = {}) {
    const dotenv = {
      DATABRICKS_CONFIG_PROFILE: "DEFAULT",
      PGHOST: "primary.production.example.com",
      PGDATABASE: database,
      LAKEBASE_ENDPOINT: `${PRODUCTION}/endpoints/primary`,
      ...env,
    };
    fs.writeFileSync(
      path.join(appRoot, ".env"),
      `${Object.entries(dotenv)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n")}\n`,
    );
    return fakeContext({ root: appRoot, env: dotenv, userName: USER, api });
  }

  const onDev = (appRoot: string) =>
    context(appRoot, {
      PGHOST: `primary.${devBranchId(USER)}.example.com`,
      LAKEBASE_ENDPOINT: `${DEV}/endpoints/primary`,
      PGUSER: USER,
    });

  async function init(ctx: DbContext, options: InitOptions = {}) {
    const steps: string[] = [];
    const report = await runInit(ctx, {
      ...options,
      onStep: (step) => steps.push(step),
    });
    return { report, steps };
  }

  beforeAll(async () => {
    cluster = new Pool({ connectionString: url, max: 1 });
    await cluster.query(`create database "${database}"`);
    await cluster.query(`
      create role "${sp}" login password 'appkit';
      create role "${superuser}" nologin;
      grant pg_read_all_data, pg_write_all_data to "${superuser}";
      create role "${dev}" login password 'appkit';
      grant "${superuser}" to "${dev}";
      grant create on database "${database}" to "${sp}", "${dev}";
    `);
    const adminUrl = new URL(url as string);
    adminUrl.pathname = `/${database}`;
    admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    // What a deployed app on public needs too: CREATE on it, which Postgres 15 stopped granting to every role.
    await admin.query(`grant create on schema public to "${sp}", "${dev}"`);
    asSp = new Pool({ connectionString: inDatabase(sp, "appkit"), max: 1 });
    asDev = new Pool({ connectionString: inDatabase(dev, "appkit"), max: 2 });
    withBranchPool.mockImplementation(
      (_ctx: unknown, fn: (pool: Pool) => Promise<unknown>) => fn(asDev),
    );

    const bundle = {
      "databricks.yml": databricksYml(
        PRODUCTION,
        `${PRODUCTION}/databases/databricks-postgres`,
      ),
    };
    root = tempApp({
      ...bundle,
      "config/database/schema.ts": schemaSource(app, "notes"),
    });
    publicRoot = tempApp({
      ...bundle,
      "config/database/schema.ts": schemaSource("public", `notes_${suffix}`),
    });
    await generate(root);
    await generate(publicRoot);
  }, 60_000);

  afterAll(async () => {
    await asDev?.end();
    await asSp?.end();
    await admin?.end();
    // pool.end() resolves before the server sees the clients leave; a forced
    // drop then kills them mid-close and pg raises it as an uncaught error.
    for (let tries = 0; tries < 50; tries++) {
      const { rows } = await cluster.query<{ open: number }>(
        "select count(*)::int as open from pg_stat_activity where datname = $1",
        [database],
      );
      if (rows[0]?.open === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await cluster.query(`drop database if exists "${database}"`);
    await cluster.query(`
      drop owned by "${sp}", "${dev}", "${superuser}";
      drop role if exists "${dev}";
      drop role if exists "${superuser}";
      drop role if exists "${sp}";
    `);
    await cluster.end();
    cleanupTempApps();
  });

  beforeEach(async () => {
    await admin.query(`drop schema if exists "${app}" cascade`);
    await admin.query(`
      drop table if exists public."notes_${suffix}";
      drop table if exists public.__drizzle_migrations;
    `);
    lakebase = project();
    api = apiWithRealHandOff(lakebase);
  });

  test("a copy the service principal owns is handed to you and rebuilt: the copied rows go, the journal records the migrations", async () => {
    await deployed(root, app, `"${app}".notes`);

    const { report, steps } = await init(context(root));

    expect(report).toMatchObject({
      created: true,
      sourceBranch: PRODUCTION,
      handedOff: sp,
      keptCopy: null,
      start: {
        kind: "clean",
        reason: "fork-copy",
        migrate: { applied: ["0000_migration"] },
      },
    });
    expect(steps).toContain(
      `Dropping schema ${app} on ${devBranchId(USER)}: the branch still holds the rows the fork copied, and the committed migrations recreate its tables`,
    );
    expect(lakebase.calls).toContain(
      `deleteRole ${DEV}/roles/dbrx-apps-${sp} → ${DEV}/roles/alice`,
    );
    expect(await ownerOf(app)).toBe(dev);
    expect(await rows(`"${app}".notes`)).toEqual([]);
    expect(await journal(app)).toEqual([
      hashOf(folder(root), "0000_migration"),
    ]);
  });

  test("a run that stopped after the hand-off is finished by the next init, which forks nothing", async () => {
    await deployed(root, app, `"${app}".notes`);
    await asDev.query(
      `insert into "${app}".__drizzle_migrations (hash, created_at) values ($1, 0)`,
      [FORK_COPY_TAG],
    );
    await admin.query(`reassign owned by "${sp}" to "${dev}"`);
    existingDev(lakebase);

    const { report } = await init(onDev(root));

    expect(report).toMatchObject({
      created: false,
      handedOff: null,
      start: { kind: "clean", migrate: { applied: ["0000_migration"] } },
    });
    expect(lakebase.calls.some((call) => call.startsWith("deleteRole"))).toBe(
      false,
    );
    expect(await rows(`"${app}".notes`)).toEqual([]);
    expect(await journal(app)).toEqual([
      hashOf(folder(root), "0000_migration"),
    ]);
  });

  test("your working branch keeps its rows: init migrates it", async () => {
    await applyPendingMigrations(asDev, {
      migrationsFolder: folder(root),
      schemaName: app,
    });
    await asDev.query(`insert into "${app}".notes (body) values ('mine')`);
    existingDev(lakebase);

    const { report } = await init(onDev(root));

    expect(report).toMatchObject({
      created: false,
      handedOff: null,
      keptCopy: null,
      start: { kind: "migrate", migrate: { generated: null, applied: [] } },
    });
    expect(await rows(`"${app}".notes`)).toEqual([{ body: "mine" }]);
  });

  test("a fork of a source whose app schema you already owned is a copy too: rebuilt without a hand-off, so the copied rows go", async () => {
    await applyPendingMigrations(asDev, {
      migrationsFolder: folder(root),
      schemaName: app,
    });
    await asDev.query(`insert into "${app}".notes (body) values ('copied')`);

    const { report, steps } = await init(context(root));

    expect(report).toMatchObject({
      created: true,
      sourceBranch: PRODUCTION,
      handedOff: null,
      keptCopy: null,
      start: { kind: "clean", migrate: { applied: ["0000_migration"] } },
    });
    expect(steps).toContain(
      `Dropping schema ${app} on ${devBranchId(USER)}: the branch still holds the rows the fork copied, and the committed migrations recreate its tables`,
    );
    expect(lakebase.calls.some((call) => call.startsWith("deleteRole"))).toBe(
      false,
    );
    expect(await rows(`"${app}".notes`)).toEqual([]);
    expect(await journal(app)).toEqual([
      hashOf(folder(root), "0000_migration"),
    ]);
  });

  test("--schema none touches nothing, and the next plain init still rebuilds", async () => {
    await deployed(root, app, `"${app}".notes`);

    const untouched = await init(context(root), { schema: "none" });
    expect(untouched.report).toMatchObject({
      created: true,
      handedOff: null,
      start: { kind: "none" },
    });
    expect(await ownerOf(app)).toBe(sp);
    expect(await rows(`"${app}".notes`)).toEqual([{ body: "copied" }]);

    const rebuilt = await init(onDev(root));
    expect(rebuilt.report).toMatchObject({
      created: false,
      handedOff: sp,
      start: { kind: "clean" },
    });
    expect(await ownerOf(app)).toBe(dev);
    expect(await rows(`"${app}".notes`)).toEqual([]);
  });

  test("--schema migrate on a copy keeps its rows, removes the tag and reports where they came from", async () => {
    await deployed(root, app, `"${app}".notes`);
    await asDev.query(
      `insert into "${app}".__drizzle_migrations (hash, created_at) values ($1, 0)`,
      [FORK_COPY_TAG],
    );

    const { report } = await init(context(root), { schema: "migrate" });

    expect(report).toMatchObject({
      handedOff: sp,
      keptCopy: { reason: "requested", from: PRODUCTION },
      start: { kind: "migrate", migrate: { generated: null, applied: [] } },
    });
    expect(await ownerOf(app)).toBe(dev);
    expect(await rows(`"${app}".notes`)).toEqual([{ body: "copied" }]);
    expect(await journal(app)).toEqual([
      hashOf(folder(root), "0000_migration"),
    ]);

    const kept = await init(onDev(root));
    expect(kept.report.start.kind).toBe("migrate");
    expect(await rows(`"${app}".notes`)).toEqual([{ body: "copied" }]);

    const asked: string[] = [];
    const cleaned = await init(onDev(root), {
      schema: "clean",
      confirmClean: async ({ schemaName }) => {
        asked.push(schemaName);
        return true;
      },
    });
    expect(asked).toEqual([app]);
    expect(cleaned.report.start).toMatchObject({
      kind: "clean",
      reason: "requested",
    });
    expect(await rows(`"${app}".notes`)).toEqual([]);
  });

  test("migrate, introspect and seed refuse an untouched copy the service principal still owns", async () => {
    await deployed(root, app, `"${app}".notes`);
    existingDev(lakebase);
    lakebase.addRole(DEV, `dbrx-apps-${sp}`, sp);
    const ctx = onDev(root);
    const refusal = `${devBranchId(USER)} still holds the rows the fork copied into schema "${app}", which "${sp}" still owns. Run \`appkit db init\` to rebuild it from the committed migrations, or \`appkit db init --schema`;

    await expect(runMigrate(ctx, { interactive: false })).rejects.toThrow(
      `Did not apply: ${refusal} migrate\` to keep them.`,
    );
    const introspect = runIntrospect(ctx, { interactive: false });
    await expect(introspect).rejects.toBeInstanceOf(IntrospectRefusedError);
    await expect(introspect).rejects.toThrow(
      `Refusing to introspect: ${refusal} introspect\` to keep them.`,
    );
    fs.writeFileSync(
      path.join(root, SEED_FILE),
      `insert into notes (body) values ('seeded');`,
    );
    try {
      await expect(runSeed(ctx)).rejects.toThrow(
        `Refusing to seed: ${refusal} migrate\` to keep them.`,
      );
    } finally {
      fs.rmSync(path.join(root, SEED_FILE));
    }
    expect(await ownerOf(app)).toBe(sp);
    expect(await rows(`"${app}".notes`)).toEqual([{ body: "copied" }]);
  });

  test("migrate, introspect and seed refuse a branch whose journal still carries the tag", async () => {
    await deployed(root, app, `"${app}".notes`);
    await asDev.query(
      `insert into "${app}".__drizzle_migrations (hash, created_at) values ($1, 0)`,
      [FORK_COPY_TAG],
    );
    await admin.query(`reassign owned by "${sp}" to "${dev}"`);
    existingDev(lakebase);
    const ctx = onDev(root);
    const refusal = `${devBranchId(USER)} still holds the rows the fork copied into schema "${app}", and its rebuild did not finish. Run \`appkit db init\` to rebuild it from the committed migrations, or \`appkit db init --schema`;

    await expect(runMigrate(ctx, { interactive: false })).rejects.toThrow(
      `Did not apply: ${refusal} migrate\` to keep them.`,
    );
    const introspect = runIntrospect(ctx, { interactive: false });
    await expect(introspect).rejects.toBeInstanceOf(IntrospectRefusedError);
    await expect(introspect).rejects.toThrow(
      `Refusing to introspect: ${refusal} introspect\` to keep them.`,
    );
    fs.writeFileSync(
      path.join(root, SEED_FILE),
      `insert into notes (body) values ('seeded');`,
    );
    try {
      await expect(runSeed(ctx)).rejects.toThrow(
        `Refusing to seed: ${refusal} migrate\` to keep them.`,
      );
    } finally {
      fs.rmSync(path.join(root, SEED_FILE));
    }
    expect(await rows(`"${app}".notes`)).toEqual([{ body: "copied" }]);
  });

  test("schema public is migrated, never handed off, and the service principal's tables that kept their rows are reported", async () => {
    const table = `public."notes_${suffix}"`;
    await deployed(publicRoot, "public", table);

    const { report } = await init(context(publicRoot));

    expect(report).toMatchObject({
      created: true,
      handedOff: null,
      start: { kind: "migrate", migrate: { generated: null, applied: [] } },
    });
    expect(report.keptCopy?.reason).toBe("public");
    expect(
      report.keptCopy?.reason === "public" && report.keptCopy.objects,
    ).toContain(`table notes_${suffix}`);
    expect(lakebase.calls.some((call) => call.startsWith("deleteRole"))).toBe(
      false,
    );
    expect(await rows(table)).toEqual([{ body: "copied" }]);
  });
});
