import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { cleanHolding, introspectHolding, migrateHolding, withBranchPool } =
  vi.hoisted(() => ({
    cleanHolding: vi.fn(),
    introspectHolding: vi.fn(),
    migrateHolding: vi.fn(),
    withBranchPool: vi.fn(),
  }));

vi.mock("../context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../context")>()),
  withBranchPool,
}));
vi.mock("../migrate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../migrate")>()),
  migrateHolding,
}));
vi.mock("../clean", () => ({ cleanHolding }));
vi.mock("../introspect", () => ({ introspectHolding }));

import type { DbContext } from "../context";
import type { HistoryLock } from "../history-lock";
import { type InitOptions, runInit } from "../init";
import { LakebaseApiError } from "../lakebase-api";
import { runMigrate } from "../migrate";
import { DRIZZLE_KIT_VERSION } from "../migrations";
import { devBranchId, sessionBranchId } from "../naming";
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
const session = (id: string) => `${P}/branches/${sessionBranchId(USER, id)}`;
const migrateReport = {
  generated: null,
  applied: [],
  typesFile: "/app/shared/appkit-types/database.d.ts",
};

/** What the hand-off reads on the branch: the app schema's owner, and what blocks deleting that role. */
let schemaOwner: string | null;
let blockers: { database: string; count: number }[];
const queries: string[] = [];
const pool = {
  query: vi.fn(async (text: string) => {
    queries.push(text);
    if (text.includes("nspowner")) {
      return { rows: [{ owner: schemaOwner, current_user: USER }] };
    }
    if (text.includes("pg_shdepend")) return { rows: blockers };
    throw new Error(`unexpected query ${text}`);
  }),
};

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
    files = {},
  }: { schema?: boolean; deploy?: string; files?: Record<string, string> } = {},
): DbContext {
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
    ...(schema ? { "config/database/schema.ts": schemaSource("app") } : {}),
    ...files,
  });
  return fakeContext({
    root,
    env: dotenv,
    userName: USER,
    api: lakebase.api(),
  });
}

const builder = path.resolve(
  import.meta.dirname,
  "../../schema-builder/index.ts",
);
function schemaSource(schemaName: string): string {
  return `import { defineSchema, id } from ${JSON.stringify(builder)};
export const schema = defineSchema(({ table }) => ({ notes: table("notes", { id: id() }) }), { schemaName: ${JSON.stringify(schemaName)} });
`;
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

/** Run init, collecting its progress lines. */
async function init(ctx: DbContext, options: InitOptions = {}) {
  const steps: string[] = [];
  const report = await runInit(ctx, {
    ...options,
    onStep: (step) => steps.push(step),
  });
  return { report, steps };
}

function conflict(name: string): LakebaseApiError {
  return new LakebaseApiError(`create branch ${name}`, "ALREADY_EXISTS", {
    statusCode: 409,
    errorCode: "ALREADY_EXISTS",
  });
}

beforeEach(() => {
  schemaOwner = SP;
  blockers = [];
  queries.length = 0;
  pool.query.mockClear();
  withBranchPool
    .mockReset()
    .mockImplementation((_ctx, fn: (p: unknown) => unknown) => fn(pool));
  migrateHolding.mockReset().mockResolvedValue(migrateReport);
  cleanHolding.mockReset().mockResolvedValue({
    branch: DEV,
    schemaName: "app",
    dependents: [],
  });
  introspectHolding.mockReset().mockResolvedValue({ branch: DEV, tables: [] });
});
afterEach(cleanupTempApps);

describe("runInit — dev branch", () => {
  test("forks the default branch with no expiry, hands the app schema to you, rewrites .env, migrates", async () => {
    const lakebase = project();
    const ctx = appOn(lakebase);

    const { report, steps } = await init(ctx);

    expect(lakebase.calls).toContain(
      `createBranch ${devBranchId(USER)} ${JSON.stringify({ source_branch: PRODUCTION, no_expiry: true })}`,
    );
    // Only the owner of the app schema is deleted; Bob's copied role stays.
    expect(
      lakebase.calls.filter((call) => call.startsWith("deleteRole")),
    ).toEqual([`deleteRole ${DEV}/roles/dbrx-apps-${SP} → ${DEV}/roles/alice`]);
    expect(report).toMatchObject({
      mode: "dev",
      branch: DEV,
      created: true,
      sourceBranch: PRODUCTION,
      expireTime: null,
      endpoint: `${DEV}/endpoints/primary`,
      endpointCreated: false,
      host: `primary.${devBranchId(USER)}.example.com`,
      database: "databricks_postgres",
      user: USER,
      role: { name: `${DEV}/roles/alice`, action: "kept" },
      handedOff: SP,
      installed: null,
      start: { kind: "migrate", migrate: migrateReport },
    });
    expect(steps).toEqual([
      `Creating ${devBranchId(USER)} from production`,
      `Pointing .env at ${devBranchId(USER)}, database databricks_postgres`,
      `Handing schema app in database databricks_postgres on ${devBranchId(USER)} to you: deleting this branch's copy of role ${SP}, which owns it, with its objects reassigned to you`,
      `Migrating schema app on ${devBranchId(USER)}`,
    ]);

    const written = envFile(ctx.root);
    expect(written).toEqual({
      DATABRICKS_CONFIG_PROFILE: "DEFAULT",
      LAKEBASE_PROJECT: P,
      PGHOST: `primary.${devBranchId(USER)}.example.com`,
      LAKEBASE_ENDPOINT: `${DEV}/endpoints/primary`,
      PGDATABASE: "databricks_postgres",
      PGUSER: USER,
      PGPORT: "5432",
      PGSSLMODE: "require",
    });
    expect(fs.readFileSync(path.join(ctx.root, ".env"), "utf-8")).toMatch(
      /^# Lakebase\n/,
    );
    // Migrate runs against the new branch; the caller's environment is left alone.
    const [migrateCtx, , migrateOptions] = migrateHolding.mock.calls[0] ?? [];
    expect(migrateCtx.env.LAKEBASE_ENDPOINT).toBe(`${DEV}/endpoints/primary`);
    expect(migrateOptions).toEqual({ interactive: false });
    expect(ctx.env.LAKEBASE_ENDPOINT).toBe(`${PRODUCTION}/endpoints/primary`);
  });

  test("a re-run reuses the dev branch; when you own the app schema there is no hand-off", async () => {
    const lakebase = project();
    lakebase.addBranch(DEV);
    lakebase.addRole(DEV, "alice", USER, ["DATABRICKS_SUPERUSER"]);
    lakebase.addRole(DEV, `dbrx-apps-${SP}`, SP);
    schemaOwner = USER;

    const { report, steps } = await init(appOn(lakebase), { schema: "none" });

    expect(report).toMatchObject({
      created: false,
      handedOff: null,
      start: { kind: "none" },
    });
    expect(steps[0]).toBe(`Using ${devBranchId(USER)}`);
    expect(
      lakebase.calls.some((call) =>
        /^(createBranch|deleteRole|createRole|createEndpoint)/.test(call),
      ),
    ).toBe(false);
    expect(queries.some((text) => text.includes("pg_shdepend"))).toBe(false);
  });

  test("the hand-off reads the schema schema.ts names", async () => {
    const lakebase = project();
    const ctx = appOn(lakebase, {}, { schema: false });
    fs.mkdirSync(path.join(ctx.root, "config/database"), { recursive: true });
    fs.writeFileSync(
      path.join(ctx.root, "config/database/schema.ts"),
      schemaSource("sales"),
    );

    const { steps } = await init(ctx, { schema: "none" });

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("nspowner"),
      ["sales"],
    );
    expect(steps).toContain(
      `Handing schema sales in database databricks_postgres on ${devBranchId(USER)} to you: deleting this branch's copy of role ${SP}, which owns it, with its objects reassigned to you`,
    );
  });

  test("creates a read-write endpoint that scales to zero after 5 idle minutes when the branch has none", async () => {
    const lakebase = project();
    lakebase.autoEndpoint = false;

    const { report, steps } = await init(appOn(lakebase), { schema: "none" });

    expect(lakebase.calls).toContain(
      `createEndpoint ${DEV} primary suspend=300s`,
    );
    expect(report.endpointCreated).toBe(true);
    expect(steps).toContain(
      `Creating a read-write endpoint on ${devBranchId(USER)} that suspends after 5 idle minutes`,
    );
  });

  test("creates your role when missing, and adds the superuser membership to one without it", async () => {
    schemaOwner = USER;
    const lakebase = new FakeLakebase();
    lakebase.addBranch(PRODUCTION, { default: true });

    const created = await init(appOn(lakebase), { schema: "none" });
    expect(created.report.role.action).toBe("created");
    expect(lakebase.calls).toContain(
      `createRole ${DEV} ${JSON.stringify({ identity_type: "USER", postgres_role: USER, auth_method: "LAKEBASE_OAUTH_V1", membership_roles: ["DATABRICKS_SUPERUSER"] })}`,
    );

    const other = new FakeLakebase();
    other.addBranch(PRODUCTION, { default: true });
    other.addBranch(DEV);
    other.addRole(DEV, "alice", USER, []);
    const updated = await init(appOn(other), { schema: "none" });
    expect(updated.report.role.action).toBe("updated");
    expect(other.calls).toContain(
      `setRoleMemberships ${DEV}/roles/alice DATABRICKS_SUPERUSER`,
    );
  });

  test("a 403 on branch creation names the CAN MANAGE requirement", async () => {
    const lakebase = project();
    lakebase.createBranchError = forbidden();

    await expect(init(appOn(lakebase))).rejects.toThrow(
      `Creating ${devBranchId(USER)} needs CAN MANAGE on ${P}. Ask a project owner for it, then rerun \`appkit db init\`.`,
    );
  });

  test("when another run creates the dev branch first, the 409 reuses it", async () => {
    const lakebase = project();
    const api = lakebase.api();
    const create = api.createBranch.bind(api);
    api.createBranch = async (...args) => {
      await create(...args);
      throw conflict(DEV);
    };
    const app = appOn(lakebase);
    const ctx = fakeContext({
      root: app.root,
      env: app.env,
      userName: USER,
      api,
    });

    const { report } = await init(ctx, { schema: "none" });

    expect(report).toMatchObject({ branch: DEV, created: false });
  });

  test("a deleted dev branch, or a 409 for one that is gone, says so instead of forking again", async () => {
    const deleted = project();
    deleted.addBranch(DEV, { current_state: "DELETED" });
    await expect(init(appOn(deleted))).rejects.toThrow(
      `Your dev branch ${DEV} was deleted or expired. Restore it, or delete it for good, then rerun \`appkit db init\`. \`appkit db init --session\` sets up a session branch meanwhile.`,
    );

    const held = project();
    held.createBranchError = conflict(DEV);
    await expect(init(appOn(held))).rejects.toThrow(
      `Your dev branch ${DEV} was deleted or expired.`,
    );
  });
});

describe("runInit — branch limit", () => {
  test("stops before creating anything and lists your other branches with the delete command", async () => {
    const lakebase = project();
    const old = session("old1");
    lakebase.addBranch(old, { expire_time: "2099-01-01T00:00:00Z" });
    lakebase.addBranch(
      `${P}/branches/${sessionBranchId("bob@example.com", "b1")}`,
    );
    lakebase.createBranchError = new LakebaseApiError(
      "create branch",
      "unarchived branches limit exceeded [TraceId: abc]",
      { statusCode: 400, errorCode: "BAD_REQUEST" },
    );
    const ctx = appOn(lakebase);
    const before = fs.readFileSync(path.join(ctx.root, ".env"), "utf-8");

    await expect(init(ctx)).rejects.toThrow(
      `Project ${P} is at its branch limit, so init created nothing. Delete one of your other branches, then rerun \`appkit db init\`:\n  databricks postgres delete-branch ${old}  # expires 2099-01-01T00:00:00Z`,
    );
    expect(fs.readFileSync(path.join(ctx.root, ".env"), "utf-8")).toBe(before);
  });

  test("with none of your own, it says to ask a project owner", async () => {
    const lakebase = project();
    lakebase.createBranchError = new LakebaseApiError(
      "create branch",
      "unarchived branches limit exceeded",
      { statusCode: 400 },
    );

    await expect(init(appOn(lakebase))).rejects.toThrow(
      "none of its branches are yours. Ask a project owner to delete unused branches",
    );
  });
});

describe("runInit — session branch", () => {
  test("creates session-<your hash>-<id> with a 7-day TTL and stores APPKIT_DB_SESSION", async () => {
    const lakebase = project();
    const ctx = appOn(lakebase);

    const { report, steps } = await init(ctx, {
      mode: "session",
      schema: "none",
    });

    const id = envFile(ctx.root).APPKIT_DB_SESSION as string;
    expect(id).toMatch(/^[0-9a-z]{8}$/);
    expect(report).toMatchObject({
      mode: "session",
      branch: session(id),
      created: true,
    });
    expect(report.expireTime).not.toBeNull();
    expect(lakebase.calls).toContain(
      `createBranch ${sessionBranchId(USER, id)} ${JSON.stringify({ source_branch: PRODUCTION, ttl: "604800s" })}`,
    );
    expect(steps[0]).toBe(
      `Creating ${sessionBranchId(USER, id)} from production, expiring after 7 days`,
    );
  });

  test("--ttl sets a new session branch's TTL; a dev branch takes none, and a bad value fails before any call", async () => {
    const lakebase = project();
    const { report } = await init(appOn(lakebase), {
      mode: "session",
      ttl: "1h",
      schema: "none",
    });
    expect(lakebase.calls).toContain(
      `createBranch ${report.branch.split("/").pop()} ${JSON.stringify({ source_branch: PRODUCTION, ttl: "3600s" })}`,
    );

    const untouched = project();
    await expect(init(appOn(untouched), { ttl: "1h" })).rejects.toThrow(
      "--ttl applies to session branches only; add --session.",
    );
    await expect(
      init(appOn(untouched), { mode: "session", ttl: "soon" }),
    ).rejects.toThrow(/^Invalid --ttl "soon"/);
    expect(untouched.calls).toEqual([]);
  });

  test("the session id is in .env before the branch is created, so a failed run's rerun reuses it", async () => {
    const lakebase = project();
    lakebase.createBranchError = new Error("network down");
    const ctx = appOn(lakebase);

    await expect(init(ctx, { mode: "session" })).rejects.toThrow(
      "network down",
    );
    const id = envFile(ctx.root).APPKIT_DB_SESSION as string;
    expect(id).toMatch(/^[0-9a-z]{8}$/);

    lakebase.createBranchError = undefined;
    const rerun = fakeContext({
      root: ctx.root,
      env: { ...ctx.env, APPKIT_DB_SESSION: id },
      userName: USER,
      api: lakebase.api(),
    });
    const { report } = await init(rerun, { mode: "session", schema: "none" });
    expect(report.branch).toBe(session(id));
  });

  test("a rerun without --session keeps the session branch .env points at", async () => {
    schemaOwner = USER;
    const lakebase = project();
    lakebase.addBranch(session("k2x9q0ab"), {
      expire_time: "2099-01-01T00:00:00Z",
    });
    lakebase.addRole(session("k2x9q0ab"), "alice", USER, [
      "DATABRICKS_SUPERUSER",
    ]);
    const ctx = appOn(lakebase, {
      APPKIT_DB_SESSION: "k2x9q0ab",
      LAKEBASE_ENDPOINT: `${session("k2x9q0ab")}/endpoints/primary`,
    });

    const { report } = await init(ctx, { schema: "none" });

    expect(report).toMatchObject({
      mode: "session",
      branch: session("k2x9q0ab"),
      created: false,
      expireTime: "2099-01-01T00:00:00Z",
    });
  });

  test("an expired session branch, or a 409 for one that is gone, gets a fresh session id", async () => {
    const lakebase = project();
    lakebase.addBranch(session("k2x9q0ab"), {
      expire_time: "2000-01-01T00:00:00Z",
    });
    const ctx = appOn(lakebase, { APPKIT_DB_SESSION: "k2x9q0ab" });

    const { report } = await init(ctx, { mode: "session", schema: "none" });

    const id = envFile(ctx.root).APPKIT_DB_SESSION as string;
    expect(id).not.toBe("k2x9q0ab");
    expect(report).toMatchObject({ branch: session(id), created: true });

    const held = project();
    const api = held.api();
    const create = api.createBranch.bind(api);
    let first = true;
    api.createBranch = async (...args) => {
      if (first) {
        first = false;
        throw conflict(args[1]);
      }
      return create(...args);
    };
    const heldCtx = fakeContext({
      root: tempApp({
        "databricks.yml": databricksYml(
          PRODUCTION,
          `${PRODUCTION}/databases/db`,
        ),
      }),
      env: { LAKEBASE_PROJECT: P, APPKIT_DB_SESSION: "k2x9q0ab" },
      userName: USER,
      api,
    });
    const retried = await init(heldCtx, { mode: "session", schema: "none" });
    expect(retried.report.branch).not.toBe(session("k2x9q0ab"));
    expect(retried.report.created).toBe(true);
  });
});

describe("runInit — branches it never sets up", () => {
  test("a dev branch databricks.yml deploys to is refused before any API call or .env write", async () => {
    const lakebase = project();
    const ctx = appOn(lakebase, {}, { deploy: DEV });
    const before = fs.readFileSync(path.join(ctx.root, ".env"), "utf-8");

    await expect(init(ctx)).rejects.toThrow(
      `Refusing to set up ${devBranchId(USER)}: it is a branch databricks.yml deploys to. \`appkit db init\` only sets up your dev branch or this checkout's session branch.`,
    );
    expect(lakebase.calls).toEqual([]);
    expect(fs.readFileSync(path.join(ctx.root, ".env"), "utf-8")).toBe(before);
  });

  test("a databricks.yml binding the files cannot resolve refuses init before any API call or .env write", async () => {
    const lakebase = project();
    const ctx = appOn(
      lakebase,
      {},
      {
        files: {
          "databricks.yml": databricksYml(
            `\${resources.postgres_branches.main.name}`,
            `${PRODUCTION}/databases/databricks-postgres`,
          ),
        },
      },
    );
    const before = fs.readFileSync(path.join(ctx.root, ".env"), "utf-8");

    await expect(init(ctx)).rejects.toThrow(
      `Refusing to set up ${devBranchId(USER)}: databricks.yml may deploy to it: the files do not resolve resources.apps.app.resources[0].postgres.branch in target default`,
    );
    expect(lakebase.calls).toEqual([]);
    expect(fs.readFileSync(path.join(ctx.root, ".env"), "utf-8")).toBe(before);
  });

  test.each([
    [{ default: true }, "it is the project's default branch"],
    [{ is_protected: true }, "it is a protected branch"],
  ])(
    "an existing dev branch that became %j is refused before any change",
    async (status, reason) => {
      const lakebase = project();
      lakebase.addBranch(DEV, status);
      const ctx = appOn(lakebase);
      const before = fs.readFileSync(path.join(ctx.root, ".env"), "utf-8");

      await expect(init(ctx)).rejects.toThrow(
        `Refusing to set up ${devBranchId(USER)}: ${reason}.`,
      );
      expect(lakebase.calls).toEqual([`getBranch ${DEV}`]);
      expect(fs.readFileSync(path.join(ctx.root, ".env"), "utf-8")).toBe(
        before,
      );
    },
  );
});

describe("runInit — hand-off failures", () => {
  test("an owner the role API does not manage is named, with the fix", async () => {
    schemaOwner = "legacy_owner";

    await expect(init(appOn(project()))).rejects.toThrow(
      `Cannot hand schema app in database databricks_postgres on ${devBranchId(USER)} to you: it belongs to "legacy_owner", which is not a Lakebase-managed role. .env already points at the branch.`,
    );
  });

  test("a failed role delete lists what blocks it", async () => {
    const lakebase = project();
    lakebase.deleteRoleError = new LakebaseApiError(
      "delete role",
      "INTERNAL_ERROR",
      { statusCode: 500 },
    );
    blockers = [
      { database: "analytics", count: 3 },
      { database: "databricks_postgres", count: 1 },
    ];

    await expect(init(appOn(lakebase))).rejects.toThrow(
      `These objects and privileges of "${SP}" block the delete: database analytics (3), database databricks_postgres (1). .env already points at the branch. Drop them or reassign them to you, then rerun \`appkit db init\`.`,
    );
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("pg_shdepend"),
      [SP],
    );
  });

  test("without blockers it says to rerun", async () => {
    const lakebase = project();
    lakebase.deleteRoleError = new Error("timeout");

    await expect(init(appOn(lakebase))).rejects.toThrow(
      `deleting role "${SP}" failed (timeout). .env already points at the branch; rerun \`appkit db init\` to retry.`,
    );
  });
});

describe("runInit — schema start", () => {
  test("without schema.ts the default is introspect, which installs drizzle-kit first", async () => {
    const lakebase = project();
    const ctx = appOn(
      lakebase,
      {},
      {
        schema: false,
        files: { "package.json": "{}", "pnpm-lock.yaml": "" },
      },
    );
    const runCommand = vi.fn();
    const steps: string[] = [];

    const report = await runInit(ctx, {
      runCommand,
      onStep: (step) => steps.push(step),
    });

    const install = ["add", "-D", "-E", `drizzle-kit@${DRIZZLE_KIT_VERSION}`];
    expect(runCommand).toHaveBeenCalledWith("pnpm", install, ctx.root);
    expect(report.installed).toBe(`pnpm ${install.join(" ")}`);
    expect(report.start).toEqual({
      kind: "introspect",
      introspect: { branch: DEV, tables: [] },
    });
    expect(introspectHolding.mock.calls[0]?.[2]).toEqual({
      interactive: false,
    });
    expect(
      steps.indexOf(
        `Installing drizzle-kit ${DRIZZLE_KIT_VERSION}, which writes migrations (pnpm ${install.join(" ")})`,
      ),
    ).toBeLessThan(
      steps.indexOf(
        `Writing schema.ts from schema app on ${devBranchId(USER)}`,
      ),
    );
  });

  test("a failed install says what to run", async () => {
    const ctx = appOn(
      project(),
      {},
      { files: { "package.json": "{}", "package-lock.json": "{}" } },
    );

    await expect(
      runInit(ctx, {
        runCommand: () => {
          throw new Error("ENOTFOUND registry");
        },
      }),
    ).rejects.toThrow(
      `Installing drizzle-kit failed. Run \`npm install --save-dev --save-exact drizzle-kit@${DRIZZLE_KIT_VERSION}\`, then rerun \`appkit db init\`.`,
    );
  });

  test("clean drops the schema, then applies the committed migrations without generating; it needs no drizzle-kit", async () => {
    const ctx = appOn(project(), {}, { files: { "package.json": "{}" } });
    const runCommand = vi.fn();

    const { report } = await init(ctx, { schema: "clean", runCommand });

    expect(cleanHolding).toHaveBeenCalledOnce();
    expect(migrateHolding.mock.calls[0]?.[2]).toEqual({
      interactive: false,
      generate: false,
    });
    expect(cleanHolding.mock.invocationCallOrder[0]).toBeLessThan(
      migrateHolding.mock.invocationCallOrder[0] ?? 0,
    );
    expect(runCommand).not.toHaveBeenCalled();
    expect(report.start).toEqual({
      kind: "clean",
      clean: { branch: DEV, schemaName: "app", dependents: [] },
      migrate: migrateReport,
    });
  });

  test("one history lock covers init's clean and migrate: another command is refused meanwhile, and the lock goes at the end", async () => {
    const ctx = appOn(project(), {}, { files: { "package.json": "{}" } });
    const lockFile = path.join(ctx.root, "config/database/.appkit-db.lock");
    cleanHolding.mockImplementationOnce(async (_ctx, lock: HistoryLock) => {
      lock.assertHeld();
      expect(fs.existsSync(lockFile)).toBe(true);
      await expect(runMigrate(ctx, { interactive: false })).rejects.toThrow(
        /^Another `appkit db init` \(pid \d+ on .+\) is changing the migration history in config\/database\. /,
      );
      return { branch: DEV, schemaName: "app", dependents: [] };
    });

    await init(ctx, { schema: "clean" });

    expect(migrateHolding.mock.calls[0]?.[1]).toBe(
      cleanHolding.mock.calls[0]?.[1],
    );
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  test("--schema none takes no history lock, so an app without config/database still has none", async () => {
    const ctx = appOn(project(), {}, { schema: false });

    await init(ctx, { schema: "none" });

    expect(fs.existsSync(path.join(ctx.root, "config/database"))).toBe(false);
  });

  test.each(["migrate", "clean"] as const)(
    "%s without schema.ts fails before any change",
    async (start) => {
      const lakebase = project();
      const ctx = appOn(lakebase, {}, { schema: false });

      await expect(init(ctx, { schema: start })).rejects.toThrow(
        /^No config\/database\/schema\.ts yet/,
      );
      expect(lakebase.calls).toEqual([]);
    },
  );
});

describe("runInit — .env", () => {
  test("a missing .env gets the host init authenticated with, and never .env.example's placeholders", async () => {
    const lakebase = project();
    const root = tempApp({
      ".env.example":
        "DATABRICKS_HOST=https://your-workspace.cloud.databricks.com\nPGHOST=your_postgres_host\n",
      "databricks.yml": databricksYml(
        PRODUCTION,
        `${PRODUCTION}/databases/databricks-postgres`,
      ),
    });
    lakebase.databases.set(`${DEV}/databases/databricks-postgres`, {
      name: `${DEV}/databases/databricks-postgres`,
      status: { postgres_database: "databricks_postgres" },
    });
    const ctx = fakeContext({
      root,
      userName: USER,
      api: lakebase.api(),
      host: "https://real.cloud.databricks.com",
    });

    await init(ctx, { schema: "none" });

    expect(envFile(root)).toEqual({
      LAKEBASE_PROJECT: P,
      PGHOST: `primary.${devBranchId(USER)}.example.com`,
      LAKEBASE_ENDPOINT: `${DEV}/endpoints/primary`,
      PGDATABASE: "databricks_postgres",
      PGUSER: USER,
      PGPORT: "5432",
      PGSSLMODE: "require",
      DATABRICKS_HOST: "https://real.cloud.databricks.com",
    });
    expect(lakebase.calls).toContain(
      `getDatabase ${DEV}/databases/databricks-postgres`,
    );
    expect(fs.statSync(path.join(root, ".env")).mode & 0o777).toBe(0o600);
  });

  test("the profile init authenticated with wins over the host", async () => {
    const lakebase = project();
    const root = tempApp();
    const ctx = fakeContext({
      root,
      env: { LAKEBASE_PROJECT: P, DATABRICKS_CONFIG_PROFILE: "staging" },
      userName: USER,
      api: lakebase.api(),
      host: "https://real.cloud.databricks.com",
    });

    await init(ctx, { schema: "none" });

    expect(envFile(root).DATABRICKS_CONFIG_PROFILE).toBe("staging");
    expect(envFile(root).DATABRICKS_HOST).toBeUndefined();
  });

  test("a symlinked .env is refused before any API call", async () => {
    const lakebase = project();
    const ctx = appOn(lakebase, {}, { files: { "shared.env": "" } });
    fs.rmSync(path.join(ctx.root, ".env"));
    fs.symlinkSync(
      path.join(ctx.root, "shared.env"),
      path.join(ctx.root, ".env"),
    );

    await expect(init(ctx)).rejects.toThrow(
      /^Refusing to rewrite .*\.env: it is a symbolic link/,
    );
    expect(lakebase.calls).toEqual([]);
  });
});

describe("runInit — project", () => {
  test("no project anywhere is a clear error", async () => {
    const ctx = fakeContext({
      root: tempApp(),
      userName: USER,
      api: project().api(),
    });
    await expect(init(ctx, { schema: "none" })).rejects.toThrow(
      /No Lakebase project configured\. Set LAKEBASE_PROJECT=projects\/<project-id> in \.env/,
    );
  });

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

      const { report } = await init(ctx, { schema: "none" });

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

  test("LAKEBASE_PROJECT wins over LAKEBASE_ENDPOINT and databricks.yml; their values from another project are ignored", async () => {
    schemaOwner = USER;
    const lakebase = project();
    const otherProduction = "projects/q/branches/production";
    const otherDev = `projects/q/branches/${devBranchId(USER)}`;
    lakebase.addBranch(otherProduction, { default: true });
    lakebase.addRole(otherProduction, "alice", USER, ["DATABRICKS_SUPERUSER"]);
    const ctx = appOn(lakebase, {
      LAKEBASE_PROJECT: "q",
      PGDATABASE: "p_only_database",
    });

    const { report } = await init(ctx, { schema: "none" });

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
