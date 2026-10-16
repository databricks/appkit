import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { openBranchPool, runClean, runIntrospect, runMigrate } = vi.hoisted(
  () => ({
    openBranchPool: vi.fn(),
    runClean: vi.fn(),
    runIntrospect: vi.fn(),
    runMigrate: vi.fn(),
  }),
);

vi.mock("../context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../context")>()),
  openBranchPool,
}));
vi.mock("../migrate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../migrate")>()),
  runMigrate,
}));
vi.mock("../clean", () => ({ runClean }));
vi.mock("../introspect", () => ({ runIntrospect }));

import {
  currentBranchMode,
  defaultSchemaStart,
  resolveInitDefaults,
  runInit,
  schemaStartsFor,
} from "../init";
import { LakebaseApiError } from "../lakebase-api";
import { devBranchId } from "../naming";
import {
  cleanupTempApps,
  databricksYml,
  FakeLakebase,
  fakeContext,
  forbidden,
  tempApp,
} from "./fakes";

const USER = "alice@example.com";
const SP = "11111111-2222-3333-4444-555555555555";
const P = "projects/p";
const PRODUCTION = `${P}/branches/production`;
const DEV = `${P}/branches/${devBranchId(USER)}`;
const migrateReport = {
  generated: null,
  applied: [],
  typesFile: "/app/shared/appkit-types/database.d.ts",
};

/** pg_catalog owners the hand-off sees on the new branch. */
let owners: string[];

function project(): FakeLakebase {
  const lakebase = new FakeLakebase();
  lakebase.addBranch(PRODUCTION, { default: true });
  lakebase.addRole(PRODUCTION, "alice", USER, ["DATABRICKS_SUPERUSER"]);
  lakebase.addRole(PRODUCTION, `dbrx-apps-${SP}`, SP);
  lakebase.addRole(PRODUCTION, "dbrx-apps-user-bob", "bob@example.com");
  return lakebase;
}

/** An app that deploys to `deploy` (the default branch unless set), with .env pointing at the default branch. */
function appOn(
  lakebase: FakeLakebase,
  env: Record<string, string> = {},
  {
    schema = true,
    deploy = PRODUCTION,
  }: { schema?: boolean; deploy?: string } = {},
) {
  const dotenv = {
    DATABRICKS_CONFIG_PROFILE: "DEFAULT",
    PGHOST: "primary.production.example.com",
    PGDATABASE: "databricks_postgres",
    LAKEBASE_ENDPOINT: `${PRODUCTION}/endpoints/primary`,
    ...env,
  };
  const root = tempApp({
    ".env": `# Lakebase\n${Object.entries(dotenv)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    "databricks.yml": databricksYml(
      deploy,
      `${deploy}/databases/databricks-postgres`,
    ),
    // migrate and clean (mocked here) need the file to exist.
    ...(schema
      ? { "config/database/schema.ts": "export const schema = {};\n" }
      : {}),
  });
  return fakeContext({
    root,
    env: dotenv,
    userName: USER,
    api: lakebase.api(),
  });
}

function envFile(root: string): Record<string, string> {
  return Object.fromEntries(
    fs
      .readFileSync(path.join(root, ".env"), "utf-8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );
}

const pool = {
  query: vi.fn(async () => ({ rows: owners.map((owner) => ({ owner })) })),
  end: vi.fn(async () => undefined),
};

beforeEach(() => {
  owners = [SP, "pg_database_owner", "databricks_control_plane"];
  openBranchPool.mockReset().mockResolvedValue(pool);
  runMigrate.mockReset().mockResolvedValue(migrateReport);
  runClean.mockReset().mockResolvedValue({ branch: DEV, schemaName: "app" });
  runIntrospect.mockReset().mockResolvedValue({ branch: DEV, tables: [] });
  pool.query.mockClear();
  pool.end.mockClear();
});
afterEach(cleanupTempApps);

describe("runInit — dev branch", () => {
  test("forks the default branch with no expiry, hands the SP's objects to the developer, rewrites .env, migrates", async () => {
    const lakebase = project();
    const ctx = appOn(lakebase);

    const report = await runInit(ctx, { mode: "dev", schemaStart: "migrate" });

    expect(lakebase.calls).toContain(
      `createBranch ${devBranchId(USER)} ${JSON.stringify({ source_branch: PRODUCTION, no_expiry: true })}`,
    );
    // Only the role-API role that owns objects is reassigned; system owners are ignored.
    expect(
      lakebase.calls.filter((call) => call.startsWith("deleteRole")),
    ).toEqual([`deleteRole ${DEV}/roles/dbrx-apps-${SP} → ${DEV}/roles/alice`]);
    expect(report).toMatchObject({
      mode: "dev",
      branch: DEV,
      created: true,
      sourceBranch: PRODUCTION,
      endpoint: `${DEV}/endpoints/primary`,
      endpointCreated: false,
      host: `primary.${devBranchId(USER)}.example.com`,
      database: "databricks_postgres",
      user: USER,
      role: { name: `${DEV}/roles/alice`, action: "kept" },
      handedOff: [SP],
      cleaned: false,
      schema: migrateReport,
    });

    const written = envFile(ctx.root);
    expect(written).toMatchObject({
      DATABRICKS_CONFIG_PROFILE: "DEFAULT",
      LAKEBASE_PROJECT: P,
      PGHOST: `primary.${devBranchId(USER)}.example.com`,
      LAKEBASE_ENDPOINT: `${DEV}/endpoints/primary`,
      PGDATABASE: "databricks_postgres",
      PGUSER: USER,
      PGPORT: "5432",
      PGSSLMODE: "require",
    });
    expect(written.APPKIT_DB_SESSION).toBeUndefined();
    expect(fs.readFileSync(path.join(ctx.root, ".env"), "utf-8")).toMatch(
      /^# Lakebase\n/,
    );
    // The running context now targets the new branch (the hand-off pool and migrate read it).
    expect(ctx.env.LAKEBASE_ENDPOINT).toBe(`${DEV}/endpoints/primary`);
    expect(runMigrate).toHaveBeenCalledWith(ctx, { interactive: false });
    expect(pool.end).toHaveBeenCalledOnce();
  });

  test("a re-run reuses the dev branch; with nothing owned by others there is no hand-off", async () => {
    const lakebase = project();
    lakebase.addBranch(DEV);
    lakebase.addRole(DEV, "alice", USER, ["DATABRICKS_SUPERUSER"]);
    owners = ["pg_database_owner"];

    const report = await runInit(appOn(lakebase), {
      mode: "dev",
      schemaStart: null,
    });

    expect(report.created).toBe(false);
    expect(report.handedOff).toEqual([]);
    expect(
      lakebase.calls.some((call) =>
        /^(createBranch|deleteRole|createRole)/.test(call),
      ),
    ).toBe(false);
    expect(runMigrate).not.toHaveBeenCalled();
  });

  test("creates a read-write endpoint when the branch has none", async () => {
    const lakebase = project();
    lakebase.autoEndpoint = false;

    const report = await runInit(appOn(lakebase), {
      mode: "dev",
      schemaStart: null,
    });

    expect(lakebase.calls).toContain(`createEndpoint ${DEV} primary`);
    expect(report).toMatchObject({
      endpoint: `${DEV}/endpoints/primary`,
      endpointCreated: true,
    });
  });

  test("creates the developer role without a role_id when missing, and patches a role without the superuser membership", async () => {
    const lakebase = project();
    lakebase.addBranch(DEV);
    owners = [];
    const created = await runInit(appOn(lakebase), {
      mode: "dev",
      schemaStart: null,
    });
    expect(lakebase.calls).toContain(
      `createRole ${DEV} ${JSON.stringify({
        identity_type: "USER",
        postgres_role: USER,
        auth_method: "LAKEBASE_OAUTH_V1",
        membership_roles: ["DATABRICKS_SUPERUSER"],
      })}`,
    );
    expect(created.role.action).toBe("created");

    const patched = project();
    patched.addBranch(DEV);
    patched.addRole(DEV, "alice", USER, []);
    const report = await runInit(appOn(patched), {
      mode: "dev",
      schemaStart: null,
    });
    expect(patched.calls).toContain(
      `setRoleMemberships ${DEV}/roles/alice DATABRICKS_SUPERUSER`,
    );
    expect(report.role.action).toBe("updated");
  });

  test("a 403 on branch creation names the CAN MANAGE requirement", async () => {
    const lakebase = project();
    lakebase.createBranchError = forbidden();

    await expect(
      runInit(appOn(lakebase), { mode: "dev", schemaStart: null }),
    ).rejects.toThrow(
      /needs CAN MANAGE on projects\/p\. Ask a project owner for it\.$/,
    );
  });

  test("when another run creates the dev branch first, the 409 reuses it", async () => {
    const lakebase = project();
    const ctx = fakeContext({
      root: appOn(lakebase).root,
      env: {
        DATABRICKS_CONFIG_PROFILE: "DEFAULT",
        LAKEBASE_ENDPOINT: `${PRODUCTION}/endpoints/primary`,
      },
      userName: USER,
      api: Object.assign(lakebase.api(), {
        async createBranch() {
          lakebase.addBranch(DEV);
          lakebase.addRole(DEV, "alice", USER, ["DATABRICKS_SUPERUSER"]);
          throw new LakebaseApiError(`create branch ${DEV}`, "ALREADY_EXISTS", {
            statusCode: 409,
          });
        },
      }),
    });

    const report = await runInit(ctx, { mode: "dev", schemaStart: null });

    expect(report).toMatchObject({ branch: DEV, created: false });
    expect(envFile(ctx.root).LAKEBASE_ENDPOINT).toBe(
      `${DEV}/endpoints/primary`,
    );
  });
});

describe("runInit — session branch", () => {
  test("generates a session id, forks with a 7-day TTL, and stores APPKIT_DB_SESSION", async () => {
    const lakebase = project();
    const ctx = appOn(lakebase);

    const report = await runInit(ctx, { mode: "session", schemaStart: null });

    const sessionId = envFile(ctx.root).APPKIT_DB_SESSION;
    expect(sessionId).toMatch(/^[0-9a-z]{8}$/);
    expect(report.branch).toBe(`${P}/branches/session-${sessionId}`);
    expect(lakebase.calls).toContain(
      `createBranch session-${sessionId} ${JSON.stringify({ source_branch: PRODUCTION, ttl: "604800s" })}`,
    );
    expect(report.handedOff).toEqual([SP]);
  });

  test("the session id is in .env before the branch is created, so a failed run's rerun reuses it", async () => {
    const lakebase = project();
    lakebase.createBranchError = new Error("operation timed out");
    const ctx = appOn(lakebase);

    await expect(
      runInit(ctx, { mode: "session", schemaStart: null }),
    ).rejects.toThrow("operation timed out");
    const sessionId = envFile(ctx.root).APPKIT_DB_SESSION;
    expect(sessionId).toMatch(/^[0-9a-z]{8}$/);

    lakebase.createBranchError = undefined;
    const rerun = await runInit(
      fakeContext({
        root: ctx.root,
        env: envFile(ctx.root),
        userName: USER,
        api: lakebase.api(),
      }),
      { mode: "session", schemaStart: null },
    );
    expect(rerun.branch).toBe(`${P}/branches/session-${sessionId}`);
    expect(
      lakebase.calls.filter((call) => call.startsWith("createBranch")),
    ).toEqual([
      `createBranch session-${sessionId} ${JSON.stringify({ source_branch: PRODUCTION, ttl: "604800s" })}`,
      `createBranch session-${sessionId} ${JSON.stringify({ source_branch: PRODUCTION, ttl: "604800s" })}`,
    ]);
  });

  test("reuses this checkout's session branch, and replaces an expired one with a fresh session", async () => {
    const lakebase = project();
    lakebase.addBranch(`${P}/branches/session-k2x9q0ab`);
    lakebase.addRole(`${P}/branches/session-k2x9q0ab`, "alice", USER, [
      "DATABRICKS_SUPERUSER",
    ]);
    const reused = await runInit(
      appOn(lakebase, { APPKIT_DB_SESSION: "k2x9q0ab" }),
      {
        mode: "session",
        schemaStart: null,
      },
    );
    expect(reused).toMatchObject({
      branch: `${P}/branches/session-k2x9q0ab`,
      created: false,
    });

    const expired = project();
    expired.addBranch(`${P}/branches/session-k2x9q0ab`, {
      expire_time: "2020-01-01T00:00:00Z",
    });
    const ctx = appOn(expired, { APPKIT_DB_SESSION: "k2x9q0ab" });
    const fresh = await runInit(ctx, { mode: "session", schemaStart: null });
    expect(fresh.created).toBe(true);
    expect(fresh.branch).not.toBe(`${P}/branches/session-k2x9q0ab`);
    expect(envFile(ctx.root).APPKIT_DB_SESSION).not.toBe("k2x9q0ab");
  });
});

describe("runInit — branches it never sets up", () => {
  test.each([
    [
      "a dev branch databricks.yml deploys to",
      {},
      DEV,
      /it is a branch databricks\.yml deploys to/,
    ],
    [
      "a protected dev branch",
      { is_protected: true },
      PRODUCTION,
      /it is a protected branch/,
    ],
  ] as const)(
    "%s: refused before any change",
    async (_label, status, deploy, reason) => {
      const lakebase = project();
      lakebase.addBranch(DEV, status);
      // A role without the superuser membership and objects owned by the SP: nothing may change either.
      lakebase.addRole(DEV, "alice", USER, []);
      lakebase.addRole(DEV, `dbrx-apps-${SP}`, SP);
      lakebase.endpoints.set(DEV, []);
      const ctx = appOn(lakebase, {}, { deploy });
      const envBefore = fs.readFileSync(path.join(ctx.root, ".env"), "utf-8");

      const failure = runInit(ctx, { mode: "dev", schemaStart: "clean" });

      await expect(failure).rejects.toThrow(reason);
      await expect(failure).rejects.toThrow(
        new RegExp(
          `^Refusing to set up ${devBranchId(USER)}: .*\\. \`appkit db init\` only sets up your dev branch or this checkout's session branch, never a branch the app deploys to\\.$`,
        ),
      );
      expect(
        lakebase.calls.filter((call) =>
          /^(createBranch|createEndpoint|createRole|setRoleMemberships|deleteRole)/.test(
            call,
          ),
        ),
      ).toEqual([]);
      expect(openBranchPool).not.toHaveBeenCalled();
      expect(runClean).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(ctx.root, ".env"), "utf-8")).toBe(
        envBefore,
      );
    },
  );
});

describe("runInit — introspect start", () => {
  test("runs introspect on the branch init pointed .env at", async () => {
    const lakebase = project();
    const ctx = appOn(lakebase);

    const report = await runInit(
      ctx,
      { mode: "dev", schemaStart: "introspect" },
      { interactive: true },
    );

    expect(runIntrospect).toHaveBeenCalledWith(ctx, { interactive: true });
    expect(ctx.env.LAKEBASE_ENDPOINT).toBe(`${DEV}/endpoints/primary`);
    expect(runMigrate).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      introspect: { branch: DEV },
      schema: null,
    });
  });

  test("with schema.ts every start is offered and migrate is the default", () => {
    expect(defaultSchemaStart(true)).toBe("migrate");
    expect(schemaStartsFor(true)).toEqual(["migrate", "introspect", "clean"]);
  });

  test("without schema.ts only introspect can run", () => {
    expect(schemaStartsFor(false)).toEqual(["introspect"]);
    expect(defaultSchemaStart(false)).toBe("introspect");
  });

  test("resolveInitDefaults reports whether schema.ts exists", async () => {
    const lakebase = project();
    expect((await resolveInitDefaults(appOn(lakebase))).hasSchema).toBe(true);
    expect(
      (await resolveInitDefaults(appOn(lakebase, {}, { schema: false })))
        .hasSchema,
    ).toBe(false);
  });

  test("migrate or clean without schema.ts fails before any change", async () => {
    for (const schemaStart of ["migrate", "clean"] as const) {
      const lakebase = project();
      const ctx = appOn(lakebase, {}, { schema: false });
      const envBefore = fs.readFileSync(path.join(ctx.root, ".env"), "utf-8");

      await expect(
        runInit(ctx, { mode: "dev", schemaStart }, { interactive: false }),
      ).rejects.toThrow(
        /^No config\/database\/schema\.ts yet, so .*Run `appkit db introspect` to write it from the branch's tables, or create it\.$/,
      );
      expect(lakebase.calls).toEqual([]);
      expect(fs.readFileSync(path.join(ctx.root, ".env"), "utf-8")).toBe(
        envBefore,
      );
    }
  });
});

describe("currentBranchMode — the mode follows from the .env branch", () => {
  const endpointOf = (branch: string) => `${branch}/endpoints/primary`;

  test.each([
    ["your dev branch", { LAKEBASE_ENDPOINT: endpointOf(DEV) }, "dev"],
    [
      "this checkout's session branch",
      {
        LAKEBASE_ENDPOINT: endpointOf(`${P}/branches/session-k2x9q0ab`),
        APPKIT_DB_SESSION: "k2x9q0ab",
      },
      "session",
    ],
    [
      "someone else's session branch",
      {
        LAKEBASE_ENDPOINT: endpointOf(`${P}/branches/session-zzzz0000`),
        APPKIT_DB_SESSION: "k2x9q0ab",
      },
      null,
    ],
    ["the default branch", { LAKEBASE_ENDPOINT: endpointOf(PRODUCTION) }, null],
    [
      "any other branch",
      { LAKEBASE_ENDPOINT: endpointOf(`${P}/branches/staging`) },
      null,
    ],
  ] as const)("%s → %s", async (_label, env, mode) => {
    const lakebase = project();
    expect(await currentBranchMode(appOn(lakebase, env))).toBe(mode);
    expect((await resolveInitDefaults(appOn(lakebase, env))).mode).toBe(mode);
  });

  test("null without an endpoint, or with one from another project than LAKEBASE_PROJECT", async () => {
    const lakebase = project();
    expect(
      await currentBranchMode(
        appOn(lakebase, { LAKEBASE_ENDPOINT: "your_postgres_endpointPath" }),
      ),
    ).toBeNull();
    expect(
      await currentBranchMode(
        appOn(lakebase, {
          LAKEBASE_PROJECT: "projects/q",
          LAKEBASE_ENDPOINT: endpointOf(DEV),
        }),
      ),
    ).toBeNull();
  });
});

describe("runInit — clean start", () => {
  test("on an AppKit branch: clean, then apply the committed migrations without generating", async () => {
    const lakebase = project();
    const ctx = appOn(lakebase);

    const report = await runInit(ctx, { mode: "dev", schemaStart: "clean" });

    expect(runClean).toHaveBeenCalledWith(ctx);
    expect(runMigrate).toHaveBeenCalledWith(ctx, {
      interactive: false,
      generate: false,
    });
    expect(runClean.mock.invocationCallOrder[0]).toBeLessThan(
      runMigrate.mock.invocationCallOrder[0] ?? 0,
    );
    expect(report).toMatchObject({ cleaned: true, schema: migrateReport });
  });
});

describe("runInit — project and database from databricks.yml", () => {
  test("a fresh app (.env from .env.example placeholders) resolves both from the bundle", async () => {
    const lakebase = project();
    lakebase.databases.set(`${DEV}/databases/databricks-postgres`, {
      name: `${DEV}/databases/databricks-postgres`,
      status: { postgres_database: "databricks_postgres" },
    });
    const root = tempApp({
      ".env.example":
        "PGHOST=your_postgres_host\nLAKEBASE_ENDPOINT=your_postgres_endpointPath\nPGPORT=5432\nPGSSLMODE=require\n",
      "databricks.yml": databricksYml(
        PRODUCTION,
        `${PRODUCTION}/databases/databricks-postgres`,
      ),
    });
    const ctx = fakeContext({ root, userName: USER, api: lakebase.api() });

    const report = await runInit(ctx, { mode: "dev", schemaStart: null });

    expect(report.branch).toBe(DEV);
    expect(lakebase.calls).toContain(
      `getDatabase ${DEV}/databases/databricks-postgres`,
    );
    expect(envFile(root)).toMatchObject({
      PGHOST: `primary.${devBranchId(USER)}.example.com`,
      LAKEBASE_ENDPOINT: `${DEV}/endpoints/primary`,
      PGDATABASE: "databricks_postgres",
      PGPORT: "5432",
      PGSSLMODE: "require",
    });
  });

  test("no project anywhere is a clear error", async () => {
    const ctx = fakeContext({
      root: tempApp(),
      userName: USER,
      api: project().api(),
    });
    await expect(
      runInit(ctx, { mode: "dev", schemaStart: null }),
    ).rejects.toThrow(
      /No Lakebase project configured\. Set LAKEBASE_PROJECT=projects\/<project-id> in \.env/,
    );
  });
});

describe("runInit — LAKEBASE_PROJECT", () => {
  test.each([P, "p"])(
    "a .env with only the profile and LAKEBASE_PROJECT=%s is enough",
    async (value) => {
      const lakebase = project();
      const root = tempApp({
        ".env": `DATABRICKS_CONFIG_PROFILE=DEFAULT\nLAKEBASE_PROJECT=${value}\n`,
      });
      const ctx = fakeContext({
        root,
        env: { DATABRICKS_CONFIG_PROFILE: "DEFAULT", LAKEBASE_PROJECT: value },
        userName: USER,
        api: lakebase.api(),
      });

      const report = await runInit(ctx, { mode: "dev", schemaStart: null });

      expect(report).toMatchObject({
        branch: DEV,
        created: true,
        sourceBranch: PRODUCTION,
        database: "databricks_postgres",
      });
      expect(envFile(root)).toEqual({
        DATABRICKS_CONFIG_PROFILE: "DEFAULT",
        LAKEBASE_PROJECT: P,
        PGHOST: `primary.${devBranchId(USER)}.example.com`,
        LAKEBASE_ENDPOINT: `${DEV}/endpoints/primary`,
        PGDATABASE: "databricks_postgres",
        PGUSER: USER,
        PGPORT: "5432",
        PGSSLMODE: "require",
      });
    },
  );

  test("it wins over LAKEBASE_ENDPOINT and databricks.yml; their values from another project are ignored", async () => {
    const lakebase = project();
    const otherProduction = "projects/q/branches/production";
    const otherDev = `projects/q/branches/${devBranchId(USER)}`;
    lakebase.addBranch(otherProduction, { default: true });
    lakebase.addRole(otherProduction, "alice", USER, ["DATABRICKS_SUPERUSER"]);
    // .env and the bundle still name project p, with a database q does not have.
    const ctx = appOn(lakebase, {
      LAKEBASE_PROJECT: "q",
      PGDATABASE: "p_only_database",
    });

    const report = await runInit(ctx, { mode: "dev", schemaStart: null });

    expect(report).toMatchObject({
      branch: otherDev,
      sourceBranch: otherProduction,
      database: "databricks_postgres",
    });
    expect(lakebase.calls.some((call) => call.includes("projects/p/"))).toBe(
      false,
    );
    expect(envFile(ctx.root)).toMatchObject({
      LAKEBASE_PROJECT: "projects/q",
      LAKEBASE_ENDPOINT: `${otherDev}/endpoints/primary`,
      PGDATABASE: "databricks_postgres",
    });
  });
});
