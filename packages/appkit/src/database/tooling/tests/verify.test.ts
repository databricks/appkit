import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { openBranchPool } = vi.hoisted(() => ({ openBranchPool: vi.fn() }));

vi.mock("../context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../context")>()),
  openBranchPool,
}));

import type { DbContext, ToolingRequest } from "../context";
import { runVerify } from "../verify";
import { databricksYml, FakeLakebase } from "./fakes";

const builder = path.resolve(
  import.meta.dirname,
  "../../schema-builder/index.ts",
);
const BRANCH = "projects/p/branches/dev-alice-3f9a2c";
const MIGRATIONS = "config/database/migrations";
const roots: string[] = [];

type Migration = { tag: string; when: number };

/** An app whose schema.ts declares app.notes(id, body), with the given committed migrations. */
function app(
  migrations: Migration[] = [],
  env: NodeJS.ProcessEnv = { LAKEBASE_ENDPOINT: `${BRANCH}/endpoints/primary` },
): DbContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "appkit-db-verify-"));
  roots.push(root);
  const file = path.join(root, "config/database/schema.ts");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `import { defineSchema, id, text } from ${JSON.stringify(builder)};
     export const schema = defineSchema(({ table }) => ({
       notes: table("notes", { id: id(), body: text() }),
     }));`,
  );
  if (migrations.length > 0) {
    const meta = path.join(root, MIGRATIONS, "meta");
    fs.mkdirSync(meta, { recursive: true });
    fs.writeFileSync(
      path.join(meta, "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: migrations.map((m, idx) => ({
          idx,
          version: "7",
          when: m.when,
          tag: m.tag,
          breakpoints: true,
        })),
      }),
    );
    for (const m of migrations) {
      fs.writeFileSync(
        path.join(root, MIGRATIONS, `${m.tag}.sql`),
        `-- ${m.tag}\nselect 1;\n`,
      );
    }
  }
  return {
    root,
    env,
    workspace: () => {
      throw new Error("no workspace calls expected");
    },
    api: () => {
      throw new Error("no Lakebase API calls expected");
    },
  };
}

/** Journal rows as the migrator writes them: the file's sha256 and the journal's `when`. */
function recordedAs(ctx: DbContext, migrations: Migration[]) {
  return migrations.map((m) => ({
    hash: createHash("sha256")
      .update(
        fs.readFileSync(
          path.join(ctx.root, MIGRATIONS, `${m.tag}.sql`),
          "utf-8",
        ),
      )
      .digest("hex"),
    created_at: String(m.when),
  }));
}

/**
 * A connection answering the catalog and journal queries; it records every
 * statement.
 */
function branch(state: {
  columns: Record<string, string[]>;
  /** max(created_at) of the journal table, or "absent" without one. */
  journal: number | null | "absent";
  /** The journal table's rows. */
  recorded?: Array<{ hash: string; created_at: string }>;
  failOn?: RegExp;
}) {
  const statements: string[] = [];
  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      statements.push(text);
      if (state.failOn?.test(text)) throw new Error("connection reset");
      if (/pg_catalog\.pg_attribute/.test(text)) {
        expect(values?.[0]).toBe("app");
        return {
          rows: Object.entries(state.columns).flatMap(([table, columns]) =>
            columns.map((column) => ({
              table_name: table,
              column_name: column,
              relation_kind: "r",
            })),
          ),
        };
      }
      if (/from pg_catalog\.pg_class c\s+join/.test(text)) {
        return { rows: state.journal === "absent" ? [] : [{ "?column?": 1 }] };
      }
      if (/max\(created_at\)/.test(text)) {
        return {
          rows: [{ last: state.journal === "absent" ? null : state.journal }],
        };
      }
      if (/select hash, created_at from/.test(text)) {
        return { rows: state.recorded ?? [] };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
    end: vi.fn(async () => undefined),
  };
  openBranchPool.mockResolvedValue(pool);
  return { statements, client, pool };
}

const WRITES = /\b(insert|update|delete|create|drop|alter|grant|truncate)\b/i;

beforeEach(() => {
  openBranchPool.mockReset();
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("runVerify", () => {
  const two = [
    { tag: "0000_migration", when: 1000 },
    { tag: "0001_migration", when: 2000 },
  ];

  test("a branch that matches schema.ts and has every migration is ok", async () => {
    const ctx = app(two);
    const { pool } = branch({
      columns: { notes: ["id", "body"] },
      journal: 2000,
      recorded: recordedAs(ctx, two),
    });

    const report = await runVerify(ctx);

    expect(report).toEqual({
      kind: "local",
      branch: BRANCH,
      schemaProblems: [],
      pendingMigrations: [],
      strandedMigrations: [],
      ok: true,
    });
    expect(pool.end).toHaveBeenCalledOnce();
  });

  test("reports schema problems and pending migrations separately", async () => {
    const ctx = app(two);
    branch({
      columns: { notes: ["id"] },
      journal: 1000,
      recorded: recordedAs(ctx, two.slice(0, 1)),
    });

    const report = await runVerify(ctx);

    expect(report).toMatchObject({
      schemaProblems: ["table app.notes is missing column body"],
      pendingMigrations: ["0001_migration"],
      strandedMigrations: [],
      ok: false,
    });
  });

  test("without a journal table every committed migration is pending", async () => {
    const ctx = app([{ tag: "0000_baseline", when: 1000 }]);
    branch({ columns: {}, journal: "absent" });

    const report = await runVerify(ctx);

    expect(report).toMatchObject({
      schemaProblems: ["table app.notes does not exist"],
      pendingMigrations: ["0000_baseline"],
      strandedMigrations: [],
      ok: false,
    });
  });

  test("a migration merged out of order, older than the last one the branch ran, never runs", async () => {
    const migrations = [
      { tag: "0000_migration", when: 1000 },
      { tag: "0001_parallel", when: 1500 },
      { tag: "0002_migration", when: 2000 },
    ];
    const ctx = app(migrations);
    branch({
      columns: { notes: ["id", "body"] },
      journal: 2000,
      recorded: recordedAs(ctx, [migrations[0], migrations[2]] as Migration[]),
    });

    const report = await runVerify(ctx);

    expect(report).toMatchObject({
      pendingMigrations: [],
      strandedMigrations: [{ tag: "0001_parallel", reason: "out of order" }],
      ok: false,
    });
  });

  test("a migration edited after the branch ran it never runs again", async () => {
    const ctx = app(two);
    const recorded = recordedAs(ctx, two);
    fs.appendFileSync(
      path.join(ctx.root, MIGRATIONS, "0000_migration.sql"),
      "select 2;\n",
    );
    branch({ columns: { notes: ["id", "body"] }, journal: 2000, recorded });

    expect(await runVerify(ctx)).toMatchObject({
      strandedMigrations: [{ tag: "0000_migration", reason: "edited" }],
      ok: false,
    });
  });

  test("no committed migrations: only the schema is checked", async () => {
    const ctx = app();
    const { statements } = branch({
      columns: { notes: ["id", "body"] },
      journal: "absent",
    });

    expect((await runVerify(ctx)).ok).toBe(true);
    expect(statements.some((s) => /created_at/.test(s))).toBe(false);
  });

  test("never writes: everything runs in a READ ONLY transaction that is rolled back", async () => {
    const ctx = app([{ tag: "0000_migration", when: 1000 }]);
    const { statements, client } = branch({
      columns: { notes: ["id"] },
      journal: 500,
    });

    await runVerify(ctx);

    expect(statements[0]).toBe("BEGIN TRANSACTION READ ONLY");
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements.filter((s) => WRITES.test(s))).toEqual([]);
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  test("a failing query rolls back, discards the connection and ends the pool", async () => {
    const ctx = app([{ tag: "0000_migration", when: 1000 }]);
    const { statements, client, pool } = branch({
      columns: {},
      journal: 1000,
      failOn: /max\(created_at\)/,
    });

    await expect(runVerify(ctx)).rejects.toThrow("connection reset");
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledWith(expect.any(Error));
    expect(pool.end).toHaveBeenCalledOnce();
  });

  test("without a configured branch it points to init before connecting", async () => {
    await expect(runVerify(app([], {}))).rejects.toThrow(
      "No branch configured (PGHOST, PGDATABASE, LAKEBASE_ENDPOINT) — run `appkit db init`.",
    );
    expect(openBranchPool).not.toHaveBeenCalled();
  });

  test("without schema.ts it points to introspect", async () => {
    const ctx = app();
    fs.rmSync(path.join(ctx.root, "config/database/schema.ts"));

    await expect(runVerify(ctx)).rejects.toThrow(
      "No config/database/schema.ts yet, so there is nothing to verify. Run `appkit db introspect` to write it from the branch's tables, or create it.",
    );
    expect(openBranchPool).not.toHaveBeenCalled();
  });
});

const PRODUCTION = "projects/p/branches/production";
const DATABASE = `${PRODUCTION}/databases/db-1`;
const SP = "11111111-2222-3333-4444-555555555555";

/** GET /api/2.0/apps/my-app for a deployed, running app bound to the deploy branch. */
function runningApp(overrides: Record<string, unknown> = {}) {
  return {
    name: "my-app",
    service_principal_client_id: SP,
    resources: [
      {
        name: "postgres",
        postgres: {
          branch: PRODUCTION,
          database: DATABASE,
          permission: "CAN_CONNECT_AND_CREATE",
        },
      },
    ],
    app_status: { state: "RUNNING", message: "App is running." },
    compute_status: { state: "ACTIVE", message: "App compute is running." },
    active_deployment: {
      status: { state: "SUCCEEDED", message: "App started successfully" },
    },
    ...overrides,
  };
}

/**
 * An app that databricks.yml deploys to the deploy branch. The developer has
 * no Postgres role there: --prod must not need one.
 */
function prodApp(
  options: {
    app?: Record<string, unknown> | "missing" | Error;
    yml?: string;
    spRole?: boolean;
  } = {},
) {
  const base = app([], {});
  fs.writeFileSync(
    path.join(base.root, "databricks.yml"),
    options.yml ?? databricksYml(PRODUCTION, DATABASE),
  );
  const lakebase = new FakeLakebase();
  lakebase.addBranch(PRODUCTION, { default: true });
  if (options.spRole !== false) {
    lakebase.addRole(PRODUCTION, `dbrx-apps-${SP}`, SP);
  }
  lakebase.databases.set(DATABASE, {
    name: DATABASE,
    status: { postgres_database: "appdb" },
  });
  const requests: string[] = [];
  const ctx: DbContext = {
    ...base,
    workspace: () => ({
      apiClient: {
        request: async (request: ToolingRequest) => {
          requests.push(`${request.method} ${request.path}`);
          const response = options.app ?? runningApp();
          if (response === "missing") {
            throw Object.assign(new Error("App my-app does not exist."), {
              statusCode: 404,
            });
          }
          if (response instanceof Error) throw response;
          return response;
        },
      },
      currentUser: {
        me: async () => {
          throw new Error("--prod does not need the developer's identity");
        },
      },
    }),
    api: () => lakebase.api(),
  };
  return { ctx, lakebase, requests };
}

/** --prod's problems; fails when the report is not a deploy report. */
async function deployProblems(ctx: DbContext): Promise<readonly string[]> {
  const report = await runVerify(ctx, { prod: true });
  if (report.kind !== "deploy") throw new Error("expected a deploy report");
  return report.problems;
}

/** databricks.yml with the given resources block in place of the default app. */
function ymlWithApps(apps: string): string {
  return databricksYml(PRODUCTION, DATABASE).replace(
    /resources:\n {2}apps:\n(?: {4}.*\n)+/,
    apps,
  );
}

describe("runVerify --prod", () => {
  test("a running app bound to the deploy branch is ok, with no database connection and no role of yours there", async () => {
    const { ctx, lakebase, requests } = prodApp();

    const report = await runVerify(ctx, { prod: true });

    expect(report).toEqual({
      kind: "deploy",
      branch: PRODUCTION,
      app: "my-app",
      problems: [],
      ok: true,
    });
    expect(requests).toEqual(["GET /api/2.0/apps/my-app"]);
    expect(openBranchPool).not.toHaveBeenCalled();
    expect(lakebase.calls.sort()).toEqual([
      `getBranch ${PRODUCTION}`,
      `getDatabase ${DATABASE}`,
      `listRoles ${PRODUCTION}`,
    ]);
  });

  test("does not need schema.ts", async () => {
    const { ctx } = prodApp();
    fs.rmSync(path.join(ctx.root, "config/database/schema.ts"));

    expect((await runVerify(ctx, { prod: true })).ok).toBe(true);
  });

  test("an app that does not exist yet: deploy it", async () => {
    const { ctx, lakebase } = prodApp({ app: "missing" });

    expect(await runVerify(ctx, { prod: true })).toMatchObject({
      problems: [
        "app my-app is not deployed yet: `databricks apps deploy` creates it and gives it access to production",
      ],
      ok: false,
    });
    expect(lakebase.calls).not.toContain(`listRoles ${PRODUCTION}`);
  });

  test.each([
    [
      "another branch",
      [
        {
          postgres: {
            branch: "projects/p/branches/staging",
            database: DATABASE,
            permission: "CAN_CONNECT_AND_CREATE",
          },
        },
      ],
      `app my-app uses branch projects/p/branches/staging, not ${PRODUCTION} from databricks.yml: \`databricks apps deploy\` applies databricks.yml`,
    ],
    [
      "no postgres resource",
      [{ sql_warehouse: { id: "w", permission: "CAN_USE" } }],
      "app my-app has no postgres resource: `databricks apps deploy` adds the one databricks.yml declares",
    ],
    [
      "another database",
      [
        {
          postgres: {
            branch: PRODUCTION,
            database: `${PRODUCTION}/databases/other`,
            permission: "CAN_CONNECT_AND_CREATE",
          },
        },
      ],
      `app my-app uses database ${PRODUCTION}/databases/other, not ${DATABASE} from databricks.yml: \`databricks apps deploy\` applies databricks.yml`,
    ],
    [
      "a permission that cannot create the schema",
      [
        {
          postgres: {
            branch: PRODUCTION,
            database: DATABASE,
            permission: "CAN_CONNECT",
          },
        },
      ],
      "app my-app's postgres resource has permission CAN_CONNECT, but the app needs CAN_CONNECT_AND_CREATE to create its schema: set it in databricks.yml, then run `databricks apps deploy`",
    ],
  ])("a postgres resource with %s", async (_label, resources, problem) => {
    const { ctx, lakebase } = prodApp({ app: runningApp({ resources }) });

    expect(await deployProblems(ctx)).toEqual([problem]);
    expect(lakebase.calls).not.toContain(`listRoles ${PRODUCTION}`);
  });

  test("a service principal without a role on the branch", async () => {
    const { ctx } = prodApp({ spRole: false });

    expect(await deployProblems(ctx)).toEqual([
      `the app's service principal ${SP} has no Postgres role on production: \`databricks apps deploy\` creates it from the app's postgres resource`,
    ]);
  });

  test.each([
    [
      "crashed",
      {
        app_status: { state: "CRASHED", message: "App crashed unexpectedly." },
      },
      "app my-app is crashed: App crashed unexpectedly. `databricks apps logs` shows why; a migration that fails stops the app on start",
    ],
    [
      // As the API returns it: a stopped app has no active_deployment.
      "stopped",
      {
        compute_status: {
          state: "STOPPED",
          message: "Start the app compute to deploy the app.",
        },
        app_status: {
          state: "UNAVAILABLE",
          message: "App status is unavailable.",
        },
        active_deployment: undefined,
      },
      "app my-app is stopped: `databricks apps start` starts its last deployment, or `databricks apps deploy` deploys the current code; it migrates on start",
    ],
    [
      "starting",
      { compute_status: { state: "STARTING" } },
      "app my-app's compute is starting",
    ],
    [
      "a failed deployment",
      {
        pending_deployment: {
          status: { state: "FAILED", message: "Build failed." },
        },
      },
      "the last deployment of app my-app failed: Build failed. `databricks apps logs` shows why",
    ],
    [
      "a deployment in progress",
      { pending_deployment: { status: { state: "IN_PROGRESS" } } },
      "a deployment of app my-app is in progress: run verify again when it finishes",
    ],
    [
      "no deployment",
      { active_deployment: undefined, app_status: { state: "UNAVAILABLE" } },
      "app my-app has no deployment yet: `databricks apps deploy` deploys it",
    ],
  ])("an app that is %s", async (_label, overrides, problem) => {
    const { ctx } = prodApp({ app: runningApp(overrides) });

    expect(await deployProblems(ctx)).toEqual([problem]);
  });

  test("a deploy branch or database that does not exist", async () => {
    const { ctx, lakebase } = prodApp();
    lakebase.databases.clear();
    expect(await deployProblems(ctx)).toEqual([
      `databricks.yml binds database ${DATABASE}, which does not exist on production`,
    ]);

    lakebase.branches.clear();
    expect(await deployProblems(ctx)).toEqual([
      `databricks.yml deploys to ${PRODUCTION}, which does not exist`,
    ]);
  });

  test("databricks.yml without an app, or with an app name verify cannot resolve, before any API call", async () => {
    const none = prodApp({ yml: ymlWithApps("") });
    expect(await runVerify(none.ctx, { prod: true })).toMatchObject({
      app: null,
      problems: ["databricks.yml declares no app"],
      ok: false,
    });
    expect(none.requests).toEqual([]);

    const interpolated = prodApp({
      yml: ymlWithApps(
        'resources:\n  apps:\n    app:\n      name: "my-app-${bundle.target}"\n',
      ),
    });
    expect(await deployProblems(interpolated.ctx)).toEqual([
      "databricks.yml names the app my-app-${bundle.target}, with a variable verify cannot resolve",
    ]);
    expect(interpolated.requests).toEqual([]);
    expect(interpolated.lakebase.calls).toEqual([]);
  });

  test("an error other than 404 from the apps API names the app", async () => {
    const { ctx } = prodApp({
      app: Object.assign(new Error("Forbidden"), { statusCode: 403 }),
    });

    await expect(runVerify(ctx, { prod: true })).rejects.toThrow(
      "Could not read app my-app: Forbidden",
    );
  });

  test("never writes and never connects to the database", async () => {
    const { ctx, lakebase } = prodApp({ spRole: false });

    await runVerify(ctx, { prod: true });

    expect(openBranchPool).not.toHaveBeenCalled();
    expect(lakebase.calls.filter((c) => !/^(get|list)[A-Z]/.test(c))).toEqual(
      [],
    );
  });

  test("without a deploy binding in databricks.yml it says so", async () => {
    const { ctx } = prodApp();
    fs.rmSync(path.join(ctx.root, "databricks.yml"));

    await expect(runVerify(ctx, { prod: true })).rejects.toThrow(
      "No deploy branch: the default target in databricks.yml binds no postgres_branch.",
    );
  });
});
