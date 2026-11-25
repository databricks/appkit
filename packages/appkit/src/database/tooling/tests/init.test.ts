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
vi.mock("../clean", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../clean")>()),
  cleanHolding,
}));
vi.mock("../introspect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../introspect")>()),
  introspectHolding,
}));

import type { DbContext } from "../context";
import type { HistoryLock } from "../history-lock";
import { type InitOptions, runInit } from "../init";
import { IntrospectRefusedError } from "../introspect";
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

let schemaOwner: string | null;
let journal: boolean;
let journalTrusted: boolean;
let tagged: boolean;
let keptInPublic: string[];
let ownedOutside: string[];
let blockers: {
  kind: "owned" | "granted";
  database: string;
  count: number;
}[];
const queries: string[] = [];
const pool = {
  query: vi.fn(async (text: string) => {
    queries.push(text);
    if (text.includes("c.relname = $2")) {
      return {
        rows: journal
          ? [
              {
                relkind: "r",
                owner: journalTrusted ? schemaOwner : "someone-else",
                schema_owner: schemaOwner,
                current_user: USER,
                row_security: false,
                trusted: journalTrusted,
              },
            ]
          : [],
      };
    }
    if (text.includes("nspowner")) {
      return { rows: [{ owner: schemaOwner, current_user: USER }] };
    }
    if (text.includes("__drizzle_migrations")) {
      if (text.startsWith("insert")) tagged = true;
      else if (text.startsWith("delete")) tagged = false;
      return { rows: text.startsWith("select") && tagged ? [{}] : [] };
    }
    if (text.includes("pg_describe_object")) {
      return { rows: keptInPublic.map((label) => ({ label })) };
    }
    if (text.includes("pg_identify_object")) {
      return { rows: ownedOutside.map((label) => ({ label })) };
    }
    if (text.includes("pg_shdepend")) return { rows: blockers };
    throw new Error(`unexpected query ${text}`);
  }),
};
const tagWrites = () =>
  queries
    .filter(
      (text) =>
        text.includes("__drizzle_migrations") && !text.startsWith("select"),
    )
    .map((text) => text.trim().split(" ")[0]);

function project(): FakeLakebase {
  const lakebase = new FakeLakebase();
  lakebase.addBranch(PRODUCTION, { default: true });
  lakebase.addDatabase(
    PRODUCTION,
    "databricks-postgres",
    "databricks_postgres",
  );
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

async function init(ctx: DbContext, options: InitOptions = {}) {
  const steps: string[] = [];
  const warnings: string[] = [];
  const events: string[] = [];
  const report = await runInit(ctx, {
    ...options,
    onStep: (step) => {
      steps.push(step);
      events.push(step);
    },
    onWarning: (warning) => {
      warnings.push(warning);
      events.push(warning);
    },
  });
  return { report, steps, warnings, events };
}

const UNTAGGED =
  /^Could not mark schema app on .* as the fork's copy\. It has no journal table, or one owned by a role init does not trust\. If this run stops before the rebuild finishes, the next `appkit db init` will see a schema that looks like your working branch and keep the copied rows\. Run `appkit db init --schema clean` then\.$/;

function conflict(name: string): LakebaseApiError {
  return new LakebaseApiError(`create branch ${name}`, "ALREADY_EXISTS", {
    statusCode: 409,
    errorCode: "ALREADY_EXISTS",
  });
}

beforeEach(() => {
  schemaOwner = SP;
  journal = true;
  journalTrusted = true;
  tagged = false;
  keptInPublic = [];
  ownedOutside = [];
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
    kept: [],
  });
  introspectHolding.mockReset().mockResolvedValue({ branch: DEV, tables: [] });
});
afterEach(cleanupTempApps);

describe("runInit — dev branch", () => {
  test("forks the default branch with no expiry, hands the app schema to you, rewrites .env, rebuilds the app schema from the migrations", async () => {
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
      start: {
        kind: "clean",
        clean: { branch: DEV, schemaName: "app", dependents: [], kept: [] },
        migrate: migrateReport,
        reason: "fork-copy",
      },
    });
    expect(steps).toEqual([
      `Creating ${devBranchId(USER)} from production (the branch databricks.yml deploys to)`,
      `Pointing .env at ${devBranchId(USER)}, database databricks_postgres`,
      `Handing schema app in database databricks_postgres on ${devBranchId(USER)} to you: deleting this branch's copy of role ${SP}, which owns it, with its objects reassigned to you`,
      `Dropping schema app on ${devBranchId(USER)}: the branch still holds the rows the fork copied, and the committed migrations recreate its tables`,
    ]);
    expect(tagWrites()).toEqual(["insert"]);
    expect(
      queries.indexOf(queries.find((text) => text.startsWith("insert")) ?? ""),
    ).toBeLessThan(queries.findIndex((text) => text.includes("pg_shdepend")));

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
    // Clean and migrate run against the new branch; the caller's environment is left alone.
    expect(cleanHolding.mock.invocationCallOrder[0]).toBeLessThan(
      migrateHolding.mock.invocationCallOrder[0] ?? 0,
    );
    const [migrateCtx, , migrateOptions] = migrateHolding.mock.calls[0] ?? [];
    expect(migrateCtx.env.LAKEBASE_ENDPOINT).toBe(`${DEV}/endpoints/primary`);
    expect(migrateOptions).toEqual({ interactive: false, generate: false });
    expect(ctx.env.LAKEBASE_ENDPOINT).toBe(`${PRODUCTION}/endpoints/primary`);
  });

  test("a re-run reuses the dev branch; when you own the app schema there is no hand-off", async () => {
    const lakebase = project();
    lakebase.addBranch(DEV);
    lakebase.addRole(DEV, "alice", USER, ["DATABRICKS_SUPERUSER"]);
    lakebase.addRole(DEV, `dbrx-apps-${SP}`, SP);
    schemaOwner = USER;

    const { report, steps } = await init(appOn(lakebase));

    expect(report).toMatchObject({
      created: false,
      handedOff: null,
      start: { kind: "migrate", migrate: migrateReport },
    });
    expect(steps[0]).toBe(`Using ${devBranchId(USER)}`);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("nspowner"),
      ["app"],
    );
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

    const { steps } = await init(ctx);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("nspowner"),
      ["sales"],
    );
    expect(steps).toContain(
      `Handing schema sales in database databricks_postgres on ${devBranchId(USER)} to you: deleting this branch's copy of role ${SP}, which owns it, with its objects reassigned to you`,
    );
  });

  test("--schema none leaves the schema's owner alone: no hand-off, no role deleted", async () => {
    const lakebase = project();

    const { report } = await init(appOn(lakebase), { schema: "none" });

    expect(report.handedOff).toBeNull();
    expect(lakebase.calls.some((call) => call.startsWith("deleteRole"))).toBe(
      false,
    );
    expect(pool.query).not.toHaveBeenCalled();
  });

  test("schema public is never handed off or tagged: a new fork is migrated, and the service principal's tables that kept their rows are reported", async () => {
    const lakebase = project();
    const ctx = appOn(
      lakebase,
      {},
      { files: { "config/database/schema.ts": schemaSource("public") } },
    );
    keptInPublic = ["table notes", "table orders"];

    const { report } = await init(ctx);

    expect(report).toMatchObject({
      handedOff: null,
      keptCopy: { reason: "public", objects: ["table notes", "table orders"] },
      start: { kind: "migrate", migrate: migrateReport },
    });
    expect(lakebase.calls.some((call) => call.startsWith("deleteRole"))).toBe(
      false,
    );
    expect(queries.some((text) => text.includes("nspowner"))).toBe(false);
    expect(queries.some((text) => text.includes("__drizzle_migrations"))).toBe(
      false,
    );
    expect(cleanHolding).not.toHaveBeenCalled();
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

describe("runInit — the fork's parent", () => {
  const STAGING = `${P}/branches/staging`;

  test("forks the branch databricks.yml deploys to when the project has it, and says so", async () => {
    const lakebase = project();
    lakebase.addBranch(STAGING);
    lakebase.addDatabase(STAGING, "databricks-postgres", "databricks_postgres");
    lakebase.addRole(STAGING, "alice", USER, ["DATABRICKS_SUPERUSER"]);
    const ctx = appOn(lakebase, {}, { deploy: STAGING });

    const { report, steps } = await init(ctx, { schema: "none" });

    expect(lakebase.calls).toContain(
      `createBranch ${devBranchId(USER)} ${JSON.stringify({ source_branch: STAGING, no_expiry: true })}`,
    );
    expect(report).toMatchObject({ created: true, sourceBranch: STAGING });
    expect(steps).toContain(
      `Creating ${devBranchId(USER)} from staging (the branch databricks.yml deploys to)`,
    );
  });

  test.each([
    ["a branch the project does not have", `${P}/branches/missing`],
    ["a branch of another project", "projects/q/branches/main"],
  ])(
    "falls back to the project's default branch when databricks.yml binds %s",
    async (_case, deploy) => {
      const lakebase = project();
      const ctx = appOn(lakebase, {}, { deploy });

      const { report, steps } = await init(ctx, { schema: "none" });

      expect(lakebase.calls).toContain(
        `createBranch ${devBranchId(USER)} ${JSON.stringify({ source_branch: PRODUCTION, no_expiry: true })}`,
      );
      expect(report).toMatchObject({ created: true, sourceBranch: PRODUCTION });
      expect(steps).toContain(
        `Creating ${devBranchId(USER)} from production (the project's default branch)`,
      );
    },
  );

  test("a deleted branch databricks.yml deploys to is not forked", async () => {
    const lakebase = project();
    lakebase.addBranch(STAGING, { current_state: "DELETED" });
    const ctx = appOn(lakebase, {}, { deploy: STAGING });

    const { report } = await init(ctx, { schema: "none" });

    expect(report.sourceBranch).toBe(PRODUCTION);
  });
});

describe("runInit — a concurrent run on the same branch", () => {
  /** The API that another run raced: it did `before` first, then this run's call returns 409. */
  function racedApi(
    lakebase: FakeLakebase,
    method: "createEndpoint" | "createRole",
  ) {
    const api = lakebase.api();
    const original = api[method].bind(api) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    (api as unknown as Record<string, unknown>)[method] = async (
      ...args: unknown[]
    ) => {
      await original(...args);
      throw conflict(method);
    };
    return api;
  }

  function withApi(
    lakebase: FakeLakebase,
    api: ReturnType<FakeLakebase["api"]>,
  ) {
    const app = appOn(lakebase);
    return fakeContext({ root: app.root, env: app.env, userName: USER, api });
  }

  test("a 409 on the endpoint reads the one the other run created", async () => {
    const lakebase = project();
    lakebase.autoEndpoint = false;
    const ctx = withApi(lakebase, racedApi(lakebase, "createEndpoint"));

    const { report } = await init(ctx, { schema: "none" });

    expect(report).toMatchObject({
      endpoint: `${DEV}/endpoints/primary`,
      endpointCreated: false,
      host: `primary.${devBranchId(USER)}.example.com`,
    });
    expect(
      lakebase.calls.filter((call) => call.startsWith("createEndpoint")),
    ).toHaveLength(1);
  });

  test("a 409 on an endpoint still coming up waits for its host", async () => {
    const lakebase = project();
    lakebase.autoEndpoint = false;
    const api = racedApi(lakebase, "createEndpoint");
    const list = api.listEndpoints.bind(api);
    let lists = 0;
    api.listEndpoints = async (branch) => {
      lists++;
      const endpoints = await list(branch);
      // The other run's endpoint has no host until the third look.
      return lists < 3
        ? endpoints.map((endpoint) => ({
            ...endpoint,
            status: { endpoint_type: endpoint.status?.endpoint_type },
          }))
        : endpoints;
    };
    const ctx = withApi(lakebase, api);
    vi.useFakeTimers();
    try {
      const run = init(ctx, { schema: "none" });
      // init reaches its wait in microtasks; the async advance lets them run, then fires the wait's timer.
      await vi.advanceTimersByTimeAsync(2_000);
      const { report, steps } = await run;

      expect(report).toMatchObject({
        endpointCreated: false,
        host: `primary.${devBranchId(USER)}.example.com`,
      });
      expect(steps).toContain(
        `Waiting for the read-write endpoint of ${devBranchId(USER)} to get a host`,
      );
      expect(lists).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a 409 on your role reads the one the other run created", async () => {
    schemaOwner = USER;
    const lakebase = new FakeLakebase();
    lakebase.addBranch(PRODUCTION, { default: true });
    const ctx = withApi(lakebase, racedApi(lakebase, "createRole"));

    const { report } = await init(ctx, { schema: "none" });

    expect(report.role).toEqual({
      name: `${DEV}/roles/rol-generated`,
      action: "kept",
    });
    expect(
      lakebase.calls.filter((call) => call.startsWith("createRole")),
    ).toHaveLength(1);
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
      `Creating ${sessionBranchId(USER, id)} from production (the branch databricks.yml deploys to), expiring after 7 days`,
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

  test("an invalid APPKIT_DB_SESSION is refused before any API call, and .env keeps it", async () => {
    const lakebase = project();
    const ctx = appOn(lakebase, { APPKIT_DB_SESSION: "My-Session" });

    await expect(init(ctx, { mode: "session" })).rejects.toThrow(
      'Invalid APPKIT_DB_SESSION "My-Session": use 1-48 lowercase letters or digits.',
    );
    expect(lakebase.calls).toEqual([]);
    expect(envFile(ctx.root).APPKIT_DB_SESSION).toBe("My-Session");
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

  test("a rerun without --session resumes a rotation that stopped before .env pointed at the new branch", async () => {
    // The rotation wrote the new id, then stopped before or after the fork.
    const beforeFork = project();
    beforeFork.addBranch(session("oldaaaaa"), {
      expire_time: "2000-01-01T00:00:00Z",
    });
    const pending = {
      APPKIT_DB_SESSION: "newbbbbb",
      LAKEBASE_ENDPOINT: `${session("oldaaaaa")}/endpoints/primary`,
    };

    const forked = await init(appOn(beforeFork, pending), { schema: "none" });

    expect(forked.report).toMatchObject({
      mode: "session",
      branch: session("newbbbbb"),
      created: true,
    });
    expect(beforeFork.branches.has(DEV)).toBe(false);

    const afterFork = project();
    afterFork.addBranch(session("oldaaaaa"), {
      expire_time: "2000-01-01T00:00:00Z",
    });
    afterFork.addBranch(session("newbbbbb"), {
      expire_time: "2099-01-01T00:00:00Z",
    });
    afterFork.addRole(session("newbbbbb"), "alice", USER, [
      "DATABRICKS_SUPERUSER",
    ]);

    const resumed = await init(appOn(afterFork, pending), { schema: "none" });

    expect(resumed.report).toMatchObject({
      mode: "session",
      branch: session("newbbbbb"),
      created: false,
    });
    expect(afterFork.branches.has(DEV)).toBe(false);
  });

  test("a --session run that stopped after the fork is resumed by a plain init, from a .env that still points elsewhere", async () => {
    schemaOwner = USER;
    const lakebase = project();
    lakebase.addBranch(session("k2x9q0ab"), {
      expire_time: "2099-01-01T00:00:00Z",
    });
    const ctx = appOn(lakebase, { APPKIT_DB_SESSION: "k2x9q0ab" });

    const { report } = await init(ctx, { schema: "none" });

    expect(report).toMatchObject({
      mode: "session",
      branch: session("k2x9q0ab"),
      created: false,
    });
    expect(lakebase.branches.has(DEV)).toBe(false);
  });

  test("a .env that points at your dev branch stays on it, even with a session id whose branch exists", async () => {
    schemaOwner = USER;
    const lakebase = project();
    lakebase.addBranch(DEV);
    lakebase.addBranch(session("k2x9q0ab"), {
      expire_time: "2099-01-01T00:00:00Z",
    });
    const ctx = appOn(lakebase, {
      APPKIT_DB_SESSION: "k2x9q0ab",
      LAKEBASE_ENDPOINT: `${DEV}/endpoints/primary`,
    });

    const { report } = await init(ctx, { schema: "none" });

    expect(report).toMatchObject({ mode: "dev", branch: DEV });
  });

  test("a failed session run says to rerun with --session, since a plain rerun can pick the dev branch", async () => {
    const lakebase = project();
    lakebase.createBranchError = forbidden();
    const ctx = appOn(lakebase);

    await expect(init(ctx, { mode: "session" })).rejects.toThrow(
      `needs CAN MANAGE on ${P}. Ask a project owner for it, then rerun \`appkit db init --session\`.`,
    );
    await expect(init(ctx)).rejects.toThrow(
      `needs CAN MANAGE on ${P}. Ask a project owner for it, then rerun \`appkit db init\`.`,
    );
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
          `${PRODUCTION}/databases/databricks-postgres`,
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
      `Cannot hand schema app in database databricks_postgres on ${devBranchId(USER)} to you: it belongs to "legacy_owner", which is not a Lakebase-managed role, and no Postgres role can hand it to you. .env already points at the branch. Set another schemaName in schema.ts, then rerun \`appkit db init\`.`,
    );
  });

  test("an owner that also owns objects outside the app schema is not deleted: the list and the manual command are given", async () => {
    const lakebase = project();
    ownedOutside = ["schema reports", "table public.shared"];

    await expect(init(appOn(lakebase))).rejects.toThrow(
      `Refusing to hand schema app in database databricks_postgres on ${devBranchId(USER)} to you: deleting role "${SP}" would also give you what else it owns on this branch: schema reports, table public.shared. .env already points at the branch. Reassign or drop them, or take them all with \`databricks postgres delete-role ${DEV}/roles/dbrx-apps-${SP} --reassign-owned-to ${DEV}/roles/alice\`, then rerun \`appkit db init\`.`,
    );
    expect(lakebase.calls.some((call) => call.startsWith("deleteRole"))).toBe(
      false,
    );
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("pg_identify_object"),
      [SP, "app"],
    );
  });

  test("catalog names in hand-off messages have their control characters escaped", async () => {
    schemaOwner = "legacy\u001b[2J";

    await expect(init(appOn(project()))).rejects.toThrow(
      'it belongs to "legacy\\u001b[2J", which is not a Lakebase-managed role',
    );

    schemaOwner = SP;
    ownedOutside = ['table public."x\ny"'];
    await expect(init(appOn(project()))).rejects.toThrow(
      'what else it owns on this branch: table public."x\\u000ay".',
    );
  });

  test("an extension the owner has is named with the manual command, and nothing is deleted", async () => {
    const lakebase = project();
    ownedOutside = ["extension pgcrypto"];

    await expect(init(appOn(lakebase))).rejects.toThrow(
      `what else it owns on this branch: extension pgcrypto. .env already points at the branch. Reassign or drop them, or take them all with \`databricks postgres delete-role ${DEV}/roles/dbrx-apps-${SP} --reassign-owned-to ${DEV}/roles/alice\`, then rerun \`appkit db init\`.`,
    );
    expect(lakebase.calls.some((call) => call.startsWith("deleteRole"))).toBe(
      false,
    );
  });

  test("an owner with objects in another database is refused before the delete, which cannot reassign them", async () => {
    const lakebase = project();
    blockers = [
      { kind: "owned", database: "analytics", count: 3 },
      { kind: "granted", database: "databricks_postgres", count: 2 },
    ];

    await expect(init(appOn(lakebase))).rejects.toThrow(
      `Refusing to hand schema app in database databricks_postgres on ${devBranchId(USER)} to you: role "${SP}" also owns objects in other databases on this branch, which deleting it cannot reassign: database analytics (3). .env already points at the branch. Reassign or drop them in those databases, then rerun \`appkit db init\`.`,
    );
    expect(lakebase.calls.some((call) => call.startsWith("deleteRole"))).toBe(
      false,
    );
  });

  test("a failed role delete lists the shared objects the owner has apart from its privileges", async () => {
    const lakebase = project();
    lakebase.deleteRoleError = new LakebaseApiError(
      "delete role",
      "INTERNAL_ERROR",
      { statusCode: 500 },
    );
    blockers = [
      { kind: "owned", database: "", count: 1 },
      { kind: "granted", database: "analytics", count: 2 },
      { kind: "granted", database: "databricks_postgres", count: 1 },
    ];

    await expect(init(appOn(lakebase))).rejects.toThrow(
      `failed (Lakebase: delete role failed: INTERNAL_ERROR). "${SP}" still owns shared objects (1), which block the delete. Privileges granted to "${SP}": database analytics (2), database databricks_postgres (1). .env already points at the branch. Reassign or drop what it owns and revoke its privileges, then rerun \`appkit db init\`.`,
    );
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("pg_shdepend"),
      [SP],
    );
  });

  test("a failed role delete with only privileges says to revoke them", async () => {
    const lakebase = project();
    lakebase.deleteRoleError = new Error("timeout");
    blockers = [{ kind: "granted", database: "analytics", count: 2 }];

    await expect(init(appOn(lakebase))).rejects.toThrow(
      `failed (timeout). Privileges granted to "${SP}": database analytics (2). .env already points at the branch. Revoke its privileges, then rerun \`appkit db init\`.`,
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
  test("without schema.ts the default on a new fork is introspect, which installs drizzle-kit first, then a rebuild from the migrations it wrote", async () => {
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
      rebuilt: {
        clean: { branch: DEV, schemaName: "app", dependents: [], kept: [] },
        migrate: migrateReport,
        reason: "fork-copy",
      },
    });
    expect(introspectHolding.mock.calls[0]?.[2]).toEqual({
      interactive: false,
      schemaName: "app",
      recordAsApplied: false,
    });
    expect(tagWrites()).toEqual(["insert"]);
    expect(introspectHolding.mock.invocationCallOrder[0]).toBeLessThan(
      cleanHolding.mock.invocationCallOrder[0] ?? 0,
    );
    const handOff = lakebase.calls.findIndex((call) =>
      call.startsWith("deleteRole"),
    );
    expect(handOff).toBeGreaterThan(-1);
    expect(
      steps.indexOf(
        `Writing schema.ts from schema app on ${devBranchId(USER)}`,
      ),
    ).toBeLessThan(steps.findIndex((step) => step.startsWith("Handing")));
    expect(cleanHolding.mock.invocationCallOrder[0]).toBeLessThan(
      migrateHolding.mock.invocationCallOrder[0] ?? 0,
    );
    expect(migrateHolding.mock.calls[0]?.[2]).toEqual({
      interactive: false,
      generate: false,
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
        schema: "migrate",
        runCommand: () => {
          throw new Error("ENOTFOUND registry");
        },
      }),
    ).rejects.toThrow(
      `Installing drizzle-kit failed. Run \`npm install --save-dev --save-exact drizzle-kit@${DRIZZLE_KIT_VERSION}\`, then rerun \`appkit db init\`.`,
    );
  });

  test("a failed install on a new fork leaves the copy tagged, so the next init rebuilds it", async () => {
    const ctx = appOn(project(), {}, { files: { "package.json": "{}" } });

    await expect(
      runInit(ctx, {
        runCommand: () => {
          throw new Error("ENOTFOUND registry");
        },
      }),
    ).rejects.toThrow(/^Installing drizzle-kit failed\./);
    expect(tagWrites()).toEqual(["insert"]);
    expect(cleanHolding).not.toHaveBeenCalled();
  });

  test("clean drops the schema, then applies the committed migrations without generating", async () => {
    const ctx = appOn(project(), {}, { files: { "package.json": "{}" } });

    const { report } = await init(ctx, {
      schema: "clean",
      runCommand: vi.fn(),
    });

    expect(cleanHolding).toHaveBeenCalledOnce();
    expect(migrateHolding.mock.calls[0]?.[2]).toEqual({
      interactive: false,
      generate: false,
    });
    expect(cleanHolding.mock.invocationCallOrder[0]).toBeLessThan(
      migrateHolding.mock.invocationCallOrder[0] ?? 0,
    );
    expect(report.start).toEqual({
      kind: "clean",
      clean: { branch: DEV, schemaName: "app", dependents: [], kept: [] },
      migrate: migrateReport,
      reason: "requested",
    });
  });

  test.each(["clean", "migrate", "introspect", undefined] as const)(
    "--schema %s installs drizzle-kit when the app lacks it, so the next migrate and check have it",
    async (schema) => {
      const ctx = appOn(project(), {}, { files: { "package.json": "{}" } });
      const runCommand = vi.fn();

      const { report } = await init(ctx, { schema, runCommand });

      const install = ["add", "-D", "-E", `drizzle-kit@${DRIZZLE_KIT_VERSION}`];
      expect(runCommand).toHaveBeenCalledWith("pnpm", install, ctx.root);
      expect(report.installed).toBe(`pnpm ${install.join(" ")}`);
    },
  );

  test("--schema none installs nothing", async () => {
    const ctx = appOn(project(), {}, { files: { "package.json": "{}" } });
    const runCommand = vi.fn();

    const { report } = await init(ctx, { schema: "none", runCommand });

    expect(runCommand).not.toHaveBeenCalled();
    expect(report.installed).toBeNull();
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
      return { branch: DEV, schemaName: "app", dependents: [], kept: [] };
    });

    await init(ctx, { schema: "clean", runCommand: vi.fn() });

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

  test("--schema none does not load schema.ts, so a half-edited one does not stop it", async () => {
    const ctx = appOn(
      project(),
      {},
      { files: { "config/database/schema.ts": "export const schema = (" } },
    );

    const { report } = await init(ctx, { schema: "none" });

    expect(report.start).toEqual({ kind: "none" });
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
      expect(fs.existsSync(path.join(ctx.root, "config/database"))).toBe(false);
    },
  );
});

describe("runInit — the start follows the branch's own state", () => {
  const dropping = (schemaName = "app") =>
    `Dropping schema ${schemaName} on ${devBranchId(USER)}: the branch still holds the rows the fork copied, and the committed migrations recreate its tables`;

  function existingDev(): FakeLakebase {
    const lakebase = project();
    lakebase.addBranch(DEV, { source_branch: PRODUCTION });
    lakebase.addRole(DEV, "alice", USER, ["DATABRICKS_SUPERUSER"]);
    return lakebase;
  }

  test("your working branch keeps its rows: migrate with schema.ts, introspect alone without", async () => {
    schemaOwner = USER;
    const withSchema = await init(appOn(existingDev()));
    expect(withSchema.report).toMatchObject({
      keptCopy: null,
      start: { kind: "migrate", migrate: migrateReport },
    });

    const withoutSchema = await init(
      appOn(existingDev(), {}, { schema: false }),
    );
    expect(withoutSchema.report.start).toEqual({
      kind: "introspect",
      introspect: { branch: DEV, tables: [] },
      rebuilt: null,
    });
    expect(introspectHolding.mock.calls[0]?.[2]).toMatchObject({
      recordAsApplied: true,
    });
    expect(cleanHolding).not.toHaveBeenCalled();
    expect(tagWrites()).toEqual([]);
  });

  test("a fork this run created is a copy even when you already owned the source schema: tagged and rebuilt, with no hand-off and no question", async () => {
    schemaOwner = USER;
    const asked: unknown[] = [];
    const confirmClean = async (target: unknown) => {
      asked.push(target);
      return true;
    };

    const lakebase = project();
    const { report, steps } = await init(appOn(lakebase));
    expect(report).toMatchObject({
      created: true,
      handedOff: null,
      keptCopy: null,
      start: { kind: "clean" },
    });
    expect(steps).toContain(dropping());
    expect(tagWrites()).toEqual(["insert"]);
    expect(lakebase.calls.some((call) => call.startsWith("deleteRole"))).toBe(
      false,
    );

    queries.length = 0;
    const explicit = await init(appOn(project()), {
      schema: "clean",
      confirmClean,
    });
    expect(explicit.report.start.kind).toBe("clean");
    expect(asked).toEqual([]);

    queries.length = 0;
    const kept = await init(appOn(project()), { schema: "migrate" });
    expect(kept.report).toMatchObject({
      created: true,
      handedOff: null,
      keptCopy: { reason: "requested", from: PRODUCTION },
      start: { kind: "migrate" },
    });
    expect(tagWrites()).toEqual(["delete"]);
  });

  test("a copy the service principal owns on an existing branch is rebuilt, from a run that forked nothing", async () => {
    const lakebase = existingDev();
    lakebase.addRole(DEV, `dbrx-apps-${SP}`, SP);

    const { report, steps } = await init(appOn(lakebase));

    expect(report).toMatchObject({
      created: false,
      handedOff: SP,
      start: { kind: "clean" },
    });
    expect(steps).toContain(dropping());
    expect(tagWrites()).toEqual(["insert"]);
  });

  test("a copy handed to you whose rebuild stopped is tagged: the next init rebuilds it without another hand-off", async () => {
    schemaOwner = USER;
    tagged = true;
    const lakebase = existingDev();

    const { report, steps } = await init(appOn(lakebase));

    expect(report).toMatchObject({
      created: false,
      handedOff: null,
      start: { kind: "clean" },
    });
    expect(steps).toContain(dropping());
    expect(lakebase.calls.some((call) => call.startsWith("deleteRole"))).toBe(
      false,
    );
    expect(tagWrites()).toEqual([]);
  });

  test("an interrupted rebuild without schema.ts introspects the copy, then rebuilds it without another hand-off or tag", async () => {
    schemaOwner = USER;
    tagged = true;
    const lakebase = existingDev();

    const { report } = await init(appOn(lakebase, {}, { schema: false }));

    expect(report.start).toMatchObject({
      kind: "introspect",
      rebuilt: { reason: "fork-copy" },
    });
    expect(introspectHolding.mock.calls[0]?.[2]).toMatchObject({
      recordAsApplied: false,
    });
    expect(introspectHolding.mock.invocationCallOrder[0]).toBeLessThan(
      cleanHolding.mock.invocationCallOrder[0] ?? 0,
    );
    expect(lakebase.calls.some((call) => call.startsWith("deleteRole"))).toBe(
      false,
    );
    expect(tagWrites()).toEqual([]);
  });

  test("a copy without a journal is rebuilt without a tag, with a warning before the hand-off that says what to do after a stop", async () => {
    journal = false;

    const { report, warnings, events } = await init(appOn(project()));

    expect(report.start.kind).toBe("clean");
    expect(tagWrites()).toEqual([]);
    expect(warnings).toEqual([expect.stringMatching(UNTAGGED)]);
    expect(events.findIndex((event) => UNTAGGED.test(event))).toBeLessThan(
      events.findIndex((event) => event.startsWith("Handing schema app")),
    );
  });

  test("a copy whose journal a role you do not trust owns is rebuilt without a tag, with the same warning: a write there could run that role's code as you", async () => {
    journalTrusted = false;

    const { report, warnings } = await init(appOn(project()));

    expect(report.start.kind).toBe("clean");
    expect(tagWrites()).toEqual([]);
    expect(warnings).toEqual([expect.stringMatching(UNTAGGED)]);
  });

  test("without an onWarning, the warning goes to onStep", async () => {
    journal = false;
    const steps: string[] = [];

    await runInit(appOn(project()), { onStep: (step) => steps.push(step) });

    expect(steps).toContainEqual(expect.stringMatching(UNTAGGED));
  });

  test("a tagged copy gets no warning", async () => {
    const { warnings } = await init(appOn(project()));

    expect(tagWrites()).toEqual(["insert"]);
    expect(warnings).toEqual([]);
  });

  test("--schema migrate or --schema introspect on a copy keeps the copied rows: handed off, untagged, and reported", async () => {
    tagged = true;
    const migrated = await init(appOn(project()), { schema: "migrate" });
    expect(migrated.report).toMatchObject({
      handedOff: SP,
      keptCopy: { reason: "requested", from: PRODUCTION },
      start: { kind: "migrate", migrate: migrateReport },
    });
    expect(tagWrites()).toEqual(["delete"]);

    const introspected = await init(appOn(project(), {}, { schema: false }), {
      schema: "introspect",
    });
    expect(introspected.report).toMatchObject({
      handedOff: SP,
      keptCopy: { reason: "requested", from: PRODUCTION },
      start: {
        kind: "introspect",
        introspect: { branch: DEV, tables: [] },
        rebuilt: null,
      },
    });
    expect(introspectHolding.mock.calls[0]?.[2]).toMatchObject({
      recordAsApplied: true,
    });
    expect(cleanHolding).not.toHaveBeenCalled();
  });

  test("--schema clean asks first only on your working branch; a copy's rebuild never asks", async () => {
    const asked: { branch: string; schemaName: string }[] = [];
    const confirmClean = async (target: {
      branch: string;
      schemaName: string;
    }) => {
      asked.push(target);
      return true;
    };

    const onCopy = await init(appOn(project()), {
      schema: "clean",
      confirmClean,
    });
    expect(asked).toEqual([]);
    expect(onCopy.report.start).toMatchObject({
      kind: "clean",
      reason: "requested",
    });

    schemaOwner = USER;
    tagged = false;
    const onYours = await init(appOn(existingDev()), {
      schema: "clean",
      confirmClean,
    });
    expect(asked).toEqual([{ branch: DEV, schemaName: "app" }]);
    expect(onYours.report.start).toMatchObject({
      kind: "clean",
      reason: "requested",
    });
  });

  test("a no to the confirmation stops before the drop, with .env already pointing at the branch", async () => {
    schemaOwner = USER;
    const ctx = appOn(existingDev());

    const { report } = await init(ctx, {
      schema: "clean",
      confirmClean: async () => false,
    });
    expect(report).toMatchObject({
      branch: DEV,
      handedOff: null,
      installed: null,
      start: { kind: "cancelled", schemaName: "app" },
    });
    expect(cleanHolding).not.toHaveBeenCalled();
    expect(envFile(ctx.root).LAKEBASE_ENDPOINT).toBe(
      `${DEV}/endpoints/primary`,
    );
  });

  test("a fork refused at creation leaves .env as it was", async () => {
    const refused = project();
    refused.createBranchError = forbidden();
    const ctx = appOn(refused);
    const before = fs.readFileSync(path.join(ctx.root, ".env"), "utf-8");

    await expect(init(ctx)).rejects.toThrow("needs CAN MANAGE");

    expect(fs.readFileSync(path.join(ctx.root, ".env"), "utf-8")).toBe(before);
  });

  test("--schema none touches nothing on a new fork, and the next plain init still rebuilds the copy", async () => {
    const lakebase = project();
    const ctx = appOn(lakebase);

    const first = await init(ctx, { schema: "none" });
    expect(first.report).toMatchObject({
      handedOff: null,
      keptCopy: null,
      start: { kind: "none" },
    });
    expect(pool.query).not.toHaveBeenCalled();

    const rerun = fakeContext({
      root: ctx.root,
      env: { ...ctx.env, ...envFile(ctx.root) },
      userName: USER,
      api: lakebase.api(),
    });
    const second = await init(rerun);
    expect(second.report).toMatchObject({
      created: false,
      handedOff: SP,
      start: { kind: "clean" },
    });
  });

  test("the hand-off and the introspect read the schema schema.ts declares", async () => {
    const ctx = appOn(
      project(),
      {},
      { files: { "config/database/schema.ts": schemaSource("sales") } },
    );

    const { steps } = await init(ctx, { schema: "introspect" });

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("nspowner"),
      ["sales"],
    );
    expect(introspectHolding.mock.calls[0]?.[2]).toEqual({
      interactive: false,
      schemaName: "sales",
      recordAsApplied: true,
    });
    expect(steps).toContain(
      `Writing schema.ts from schema sales on ${devBranchId(USER)}`,
    );
  });

  test("an introspect refusal that says to pass --schema-name names the introspect command, which has the flag", async () => {
    introspectHolding.mockRejectedValue(
      new IntrospectRefusedError(
        `Schema "app" on ${devBranchId(USER)} has no tables, so introspect would replace config/database/schema.ts with an empty one. Pass --schema-name <name> to read another schema.`,
      ),
    );

    await expect(init(appOn(project(), {}, { schema: false }))).rejects.toThrow(
      `Schema "app" on ${devBranchId(USER)} has no tables, so introspect would replace config/database/schema.ts with an empty one. Run \`appkit db introspect --schema-name <name>\` to read another schema.`,
    );
  });
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
      `getDatabase ${PRODUCTION}/databases/databricks-postgres`,
    );
    expect(fs.statSync(path.join(root, ".env")).mode & 0o777).toBe(0o600);
  });

  test("a database databricks.yml binds that the source branch does not have is refused before the fork, naming both", async () => {
    const lakebase = project();
    const root = tempApp({
      "databricks.yml": databricksYml(
        PRODUCTION,
        `${PRODUCTION}/databases/analytics`,
      ),
    });
    const ctx = fakeContext({ root, userName: USER, api: lakebase.api() });

    await expect(init(ctx, { schema: "none" })).rejects.toThrow(
      `Database analytics, which databricks.yml binds, is not on production, the branch ${devBranchId(USER)} would fork from, so init created nothing. Create it there (databricks postgres create-database ${PRODUCTION} --database-id analytics), or bind a database the project's branches have, then rerun \`appkit db init\`.`,
    );
    expect(lakebase.calls).toContain(
      `getDatabase ${PRODUCTION}/databases/analytics`,
    );
    expect(lakebase.calls.some((call) => call.startsWith("createBranch"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(root, ".env"))).toBe(false);
  });

  test("a reused branch without the database databricks.yml binds is refused, naming both, before .env is written", async () => {
    const lakebase = project();
    lakebase.addBranch(DEV);
    lakebase.addRole(DEV, "alice", USER, ["DATABRICKS_SUPERUSER"]);
    const root = tempApp({
      "databricks.yml": databricksYml(
        PRODUCTION,
        `${PRODUCTION}/databases/analytics`,
      ),
    });
    const ctx = fakeContext({ root, userName: USER, api: lakebase.api() });

    await expect(init(ctx, { schema: "none" })).rejects.toThrow(
      `Database analytics, which databricks.yml binds, is not on ${devBranchId(USER)}. Create it there (databricks postgres create-database ${DEV} --database-id analytics), or bind a database the project's branches have, then rerun \`appkit db init\`.`,
    );
    expect(lakebase.calls).toContain(`getDatabase ${DEV}/databases/analytics`);
    expect(fs.existsSync(path.join(root, ".env"))).toBe(false);
  });

  test("the database databricks.yml binds wins over .env's PGDATABASE, and init says so when they differ", async () => {
    const lakebase = project();
    const ctx = appOn(lakebase, { PGDATABASE: "scratch" });

    const { report, warnings } = await init(ctx, { schema: "none" });

    expect(report.database).toBe("databricks_postgres");
    expect(envFile(ctx.root).PGDATABASE).toBe("databricks_postgres");
    expect(warnings).toEqual([
      "Setting PGDATABASE=databricks_postgres in .env: it was scratch, and databricks.yml binds databricks_postgres",
    ]);

    const same = await init(appOn(project()), { schema: "none" });
    expect(same.warnings).toEqual([]);
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

  test.each(["prefer", "disable", "verify-full"])(
    "PGSSLMODE=%s becomes require, and init says so; require stays",
    async (weak) => {
      const ctx = appOn(project(), { PGSSLMODE: weak });

      const { steps } = await init(ctx, { schema: "none" });

      expect(envFile(ctx.root).PGSSLMODE).toBe("require");
      expect(steps).toContain(
        `Setting PGSSLMODE=require in .env: it was ${weak}, and only require makes every connection use TLS and check the server's certificate`,
      );

      const strict = appOn(project(), { PGSSLMODE: "require" });
      const kept = await init(strict, { schema: "none" });
      expect(envFile(strict.root).PGSSLMODE).toBe("require");
      expect(kept.steps.some((step) => step.includes("PGSSLMODE"))).toBe(false);
    },
  );

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
