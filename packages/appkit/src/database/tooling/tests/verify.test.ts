import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { withBranchPool } = vi.hoisted(() => ({ withBranchPool: vi.fn() }));

vi.mock("../context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../context")>()),
  withBranchPool,
}));

import type { WorkspaceRequest } from "../../../workspace-client";
import type { DbContext } from "../context";
import { runVerify, type VerifyOptions } from "../verify";
import { databricksYml, FakeLakebase } from "./fakes";

const builder = path.resolve(
  import.meta.dirname,
  "../../schema-builder/index.ts",
);
const BRANCH = "projects/p/branches/dev-alice-3f9a2c";
const ENV = {
  PGHOST: "ep-1.example.com",
  PGDATABASE: "databricks_postgres",
  LAKEBASE_ENDPOINT: `${BRANCH}/endpoints/primary`,
};
const MIGRATIONS = "config/database/migrations";
const roots: string[] = [];

type Migration = { tag: string; when: number };

function journal(migrations: Migration[]): string {
  return JSON.stringify({
    version: "7",
    dialect: "postgresql",
    entries: migrations.map((m, idx) => ({
      idx,
      version: "7",
      when: m.when,
      tag: m.tag,
      breakpoints: true,
    })),
  });
}

/** An app whose schema.ts declares app.notes(id, body), with the given committed migrations. */
function app(
  migrations: Migration[] = [],
  env: NodeJS.ProcessEnv = ENV,
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
    fs.writeFileSync(path.join(meta, "_journal.json"), journal(migrations));
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
  /** The journal table's rows; "absent" without the table. */
  recorded: Array<{ hash: string; created_at: string }> | "absent";
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
        return { rows: state.recorded === "absent" ? [] : [{ "?column?": 1 }] };
      }
      if (/select hash, created_at from/.test(text)) {
        return { rows: state.recorded === "absent" ? [] : state.recorded };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
    end: vi.fn(async () => undefined),
  };
  withBranchPool.mockImplementation(async (_ctx, fn) => {
    try {
      return await fn(pool);
    } finally {
      await pool.end();
    }
  });
  return { statements, client, pool };
}

const WRITES = /\b(insert|update|delete|create|drop|alter|grant|truncate)\b/i;

beforeEach(() => {
  withBranchPool.mockReset();
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
  const clean = {
    schemaProblems: [],
    pendingMigrations: [],
    strandedMigrations: [],
    editedMigrations: [],
    unknownMigrations: 0,
  };

  test("a branch that matches schema.ts and has every migration is ok", async () => {
    const ctx = app(two);
    const { pool } = branch({
      columns: { notes: ["id", "body"] },
      recorded: recordedAs(ctx, two),
    });

    expect(await runVerify(ctx)).toEqual({
      kind: "local",
      branch: BRANCH,
      ...clean,
      ok: true,
    });
    expect(pool.end).toHaveBeenCalledOnce();
  });

  test("reports schema problems and pending migrations separately", async () => {
    const ctx = app(two);
    branch({
      columns: { notes: ["id"] },
      recorded: recordedAs(ctx, two.slice(0, 1)),
    });

    expect(await runVerify(ctx)).toMatchObject({
      ...clean,
      schemaProblems: ["table app.notes is missing column body"],
      pendingMigrations: ["0001_migration"],
      ok: false,
    });
  });

  test("without a journal table every committed migration is pending", async () => {
    const ctx = app([{ tag: "0000_baseline", when: 1000 }]);
    branch({ columns: {}, recorded: "absent" });

    expect(await runVerify(ctx)).toMatchObject({
      schemaProblems: ["table app.notes does not exist"],
      pendingMigrations: ["0000_baseline"],
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
      recorded: recordedAs(ctx, [migrations[0], migrations[2]] as Migration[]),
    });

    expect(await runVerify(ctx)).toMatchObject({
      ...clean,
      strandedMigrations: ["0001_parallel"],
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
    branch({ columns: { notes: ["id", "body"] }, recorded });

    expect(await runVerify(ctx)).toMatchObject({
      ...clean,
      editedMigrations: ["0000_migration"],
      ok: false,
    });
  });

  test("a migration the branch ran that this checkout does not commit is reported", async () => {
    const ctx = app(two);
    branch({
      columns: { notes: ["id", "body"] },
      recorded: [
        ...recordedAs(ctx, two),
        { hash: "from-another-git-branch", created_at: "3000" },
      ],
    });

    expect(await runVerify(ctx)).toMatchObject({
      ...clean,
      unknownMigrations: 1,
      ok: false,
    });
  });

  test("no committed migrations: only the schema is checked", async () => {
    const ctx = app();
    branch({ columns: { notes: ["id", "body"] }, recorded: "absent" });

    expect((await runVerify(ctx)).ok).toBe(true);
  });

  test("never writes: everything runs in a READ ONLY transaction that is rolled back", async () => {
    const ctx = app([{ tag: "0000_migration", when: 1000 }]);
    const { statements, client } = branch({
      columns: { notes: ["id"] },
      recorded: [],
    });

    await runVerify(ctx);

    expect(statements[0]).toBe("begin transaction read only");
    expect(statements.at(-1)).toBe("rollback");
    expect(statements.filter((s) => WRITES.test(s))).toEqual([]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  test("a failing query rolls back, releases the connection and ends the pool", async () => {
    const ctx = app([{ tag: "0000_migration", when: 1000 }]);
    const { statements, client, pool } = branch({
      columns: {},
      recorded: [],
      failOn: /select hash, created_at/,
    });

    await expect(runVerify(ctx)).rejects.toThrow("connection reset");
    expect(statements.at(-1)).toBe("rollback");
    expect(client.release).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  test("without a configured branch it points to init before connecting", async () => {
    await expect(runVerify(app([], {}))).rejects.toThrow(
      "Did not verify: no branch is configured in .env (PGHOST, PGDATABASE and LAKEBASE_ENDPOINT); run `appkit db init`.",
    );
    expect(withBranchPool).not.toHaveBeenCalled();
  });

  test("without schema.ts it points to introspect", async () => {
    const ctx = app();
    fs.rmSync(path.join(ctx.root, "config/database/schema.ts"));

    await expect(runVerify(ctx)).rejects.toThrow(
      "No config/database/schema.ts yet, so there is nothing to verify. Run `appkit db introspect` to write it from the branch's tables, or create it.",
    );
    expect(withBranchPool).not.toHaveBeenCalled();
  });
});

const PRODUCTION = "projects/p/branches/production";
const DATABASE = `${PRODUCTION}/databases/db-1`;
const SP = "11111111-2222-3333-4444-555555555555";
const HOST = "https://acme.cloud.databricks.com";
const SNAPSHOT = "/Workspace/Users/sp/src/01f0";

/** The app API's response for a deployed, running app bound to the deploy branch. */
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
      deployment_artifacts: { source_code_path: SNAPSHOT },
      status: { state: "SUCCEEDED", message: "App started successfully" },
    },
    ...overrides,
  };
}

/** databricks.yml with a workspace host on its default target. */
function ymlWithHost(host = HOST): string {
  return `${databricksYml(PRODUCTION, DATABASE)}    workspace:\n      host: ${host}\n`;
}

/**
 * An app that databricks.yml deploys to the deploy branch. The developer has
 * no Postgres role there: --deployed must not need one.
 */
function deployedApp(
  options: {
    app?: Record<string, unknown> | "missing" | Error;
    yml?: string;
    spRole?: boolean;
    migrations?: Migration[];
    /** The deployed snapshot's journal: its entries, its raw text, "unreadable" when its export fails, or "missing" when it does not exist. */
    deployedJournal?: Migration[] | string;
    /** The deployed SQL by tag, else the committed SQL; "unreadable" or "missing" as for the journal. */
    deployedSql?: Record<string, string>;
    /** The deployed snapshot folder's status: "unreadable" or "missing" as for the journal; it exists otherwise. */
    snapshot?: "unreadable" | "missing";
    authenticatedHost?: string;
  } = {},
) {
  const base = app(options.migrations ?? [], {});
  fs.writeFileSync(
    path.join(base.root, "databricks.yml"),
    options.yml ?? ymlWithHost(),
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
      request: async ({ method, path: apiPath, query }: WorkspaceRequest) => {
        const appName = /^\/api\/2\.0\/apps\/([^/]+)$/.exec(apiPath)?.[1];
        if (method === "GET" && appName) {
          requests.push(`apps.get ${decodeURIComponent(appName)}`);
          const response = options.app ?? runningApp();
          if (response === "missing") {
            throw Object.assign(new Error("App my-app does not exist."), {
              statusCode: 404,
            });
          }
          if (response instanceof Error) throw response;
          return Response.json(response);
        }
        if (method === "GET" && apiPath === "/api/2.0/workspace/export") {
          expect(query?.format).toBe("AUTO");
          const file = String(query?.path);
          requests.push(`workspace.export ${file}`);
          const relative = file.slice(`${SNAPSHOT}/${MIGRATIONS}/`.length);
          const deployed = options.deployedJournal ?? options.migrations ?? [];
          const content =
            relative === "meta/_journal.json"
              ? typeof deployed === "string"
                ? deployed
                : journal(deployed)
              : (options.deployedSql?.[relative.replace(/\.sql$/, "")] ??
                `-- ${relative.replace(/\.sql$/, "")}\nselect 1;\n`);
          if (content === "unreadable") {
            throw Object.assign(new Error("Permission denied"), {
              statusCode: 403,
            });
          }
          if (content === "missing") {
            throw Object.assign(new Error("Path does not exist."), {
              statusCode: 404,
            });
          }
          return Response.json({
            content: Buffer.from(content).toString("base64"),
          });
        }
        if (method === "GET" && apiPath === "/api/2.0/workspace/get-status") {
          const file = String(query?.path);
          requests.push(`workspace.get-status ${file}`);
          if (options.snapshot === "unreadable") {
            throw Object.assign(new Error("Permission denied"), {
              statusCode: 403,
            });
          }
          if (options.snapshot === "missing" || file !== SNAPSHOT) {
            throw Object.assign(new Error("Path does not exist."), {
              statusCode: 404,
            });
          }
          return Response.json({ object_type: "DIRECTORY", path: file });
        }
        throw new Error(
          `--deployed only reads the app and its journal, not ${method} ${apiPath}`,
        );
      },
      currentUser: {
        me: async () => {
          throw new Error("--deployed does not need the developer's identity");
        },
      },
      getHost: async () => options.authenticatedHost ?? HOST,
    }),
    api: () => lakebase.api(),
  };
  return { ctx, lakebase, requests };
}

const DEPLOYED: VerifyOptions = { deployed: true };

/** --deployed's problems; fails when the report is not a deploy report. */
async function deployProblems(
  ctx: DbContext,
  options: VerifyOptions = DEPLOYED,
): Promise<readonly string[]> {
  const report = await runVerify(ctx, options);
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

describe("runVerify --deployed", () => {
  test("a running app whose snapshot has every committed migration, with the same journal entry and SQL, is ok, with no database connection and no role of yours there", async () => {
    const migrations = [{ tag: "0000_migration", when: 1000 }];
    const { ctx, lakebase, requests } = deployedApp({ migrations });

    expect(await runVerify(ctx, DEPLOYED)).toEqual({
      kind: "deploy",
      target: "default",
      host: HOST,
      branch: PRODUCTION,
      app: "my-app",
      migrations: { evidence: "verified" },
      problems: [],
      ok: true,
    });
    expect(requests).toEqual([
      "apps.get my-app",
      `workspace.export ${SNAPSHOT}/${MIGRATIONS}/meta/_journal.json`,
      `workspace.export ${SNAPSHOT}/${MIGRATIONS}/0000_migration.sql`,
    ]);
    expect(withBranchPool).not.toHaveBeenCalled();
    expect(lakebase.calls.sort()).toEqual([
      `getBranch ${PRODUCTION}`,
      `getDatabase ${DATABASE}`,
      `listRoles ${PRODUCTION}`,
    ]);
  });

  test("a committed migration the active deployment lacks fails it", async () => {
    const migrations = [
      { tag: "0000_migration", when: 1000 },
      { tag: "0001_migration", when: 2000 },
    ];
    const { ctx } = deployedApp({
      migrations,
      deployedJournal: migrations.slice(0, 1),
    });

    expect(await runVerify(ctx, DEPLOYED)).toMatchObject({
      migrations: {
        evidence: "differs",
        missing: ["0001_migration"],
        changed: [],
      },
      problems: [
        "app my-app's active deployment does not have 0001_migration, which this checkout commits: `databricks apps deploy` deploys it, and the app applies it on start",
      ],
      ok: false,
    });
  });

  test("the same tag with other SQL, or with another journal entry, in the deployment fails it", async () => {
    const migrations = [
      { tag: "0000_migration", when: 1000 },
      { tag: "0001_migration", when: 2000 },
    ];
    const { ctx, requests } = deployedApp({
      migrations,
      deployedJournal: [
        { tag: "0000_migration", when: 1000 },
        { tag: "0001_migration", when: 3000 },
      ],
      deployedSql: { "0000_migration": "-- 0000_migration\nselect 2;\n" },
    });

    expect(await runVerify(ctx, DEPLOYED)).toMatchObject({
      migrations: {
        evidence: "differs",
        missing: [],
        changed: ["0000_migration", "0001_migration"],
      },
      problems: [
        "app my-app's active deployment has 0000_migration, 0001_migration with another journal entry or other SQL than this checkout commits. A migration that ran never runs again: restore them to what was deployed, and put the change in a new migration",
      ],
      ok: false,
    });
    // Its journal entry already differs, so its SQL is not read.
    expect(requests).not.toContain(
      `workspace.export ${SNAPSHOT}/${MIGRATIONS}/0001_migration.sql`,
    );
  });

  const JOURNAL = `${SNAPSHOT}/${MIGRATIONS}/meta/_journal.json`;
  test.each([
    [
      "its journal cannot be exported",
      { deployedJournal: "unreadable" },
      `exporting ${JOURNAL} failed: Permission denied`,
    ],
    [
      "its journal is empty",
      { deployedJournal: "" },
      `${JOURNAL} exported no content`,
    ],
    [
      "its journal is not JSON",
      { deployedJournal: "{" },
      `${JOURNAL} is not JSON: `,
    ],
    [
      "its journal is not drizzle-kit's",
      {
        deployedJournal: JSON.stringify({ dialect: "mysql", entries: [] }),
      },
      `${JOURNAL} is not a drizzle-kit PostgreSQL migration journal`,
    ],
    [
      "a migration's SQL cannot be exported",
      { deployedSql: { "0000_migration": "unreadable" } },
      `exporting ${SNAPSHOT}/${MIGRATIONS}/0000_migration.sql failed: Permission denied`,
    ],
  ] as const)(
    "when %s, the migrations are unavailable and verify fails",
    async (_label, options, reason) => {
      const { ctx } = deployedApp({
        migrations: [{ tag: "0000_migration", when: 1000 }],
        ...options,
      });

      expect(await runVerify(ctx, DEPLOYED)).toMatchObject({
        migrations: {
          evidence: "unavailable",
          reason: expect.stringContaining(reason),
        },
        problems: [
          expect.stringContaining(
            `verify cannot tell whether app my-app's active deployment has the committed migrations: ${reason}`,
          ),
        ],
        ok: false,
      });
    },
  );

  test("a deployment that names no snapshot is unavailable, and its live source folder is never read", async () => {
    const { ctx, requests } = deployedApp({
      migrations: [{ tag: "0000_migration", when: 1000 }],
      app: runningApp({
        active_deployment: {
          // The live folder the deployment came from, which can change after it.
          source_code_path: "/Workspace/Users/alice@example.com/my-app",
          status: { state: "SUCCEEDED" },
        },
      }),
    });

    expect(await runVerify(ctx, DEPLOYED)).toMatchObject({
      migrations: {
        evidence: "unavailable",
        reason: "its active deployment names no source snapshot",
      },
      ok: false,
    });
    expect(
      requests.filter((request) => request.startsWith("workspace.export")),
    ).toEqual([]);
  });

  test("with committed migrations, a report that stops before reading the deployment leaves them unverified", async () => {
    const { ctx } = deployedApp({
      migrations: [{ tag: "0000_migration", when: 1000 }],
      app: "missing",
    });

    expect(await runVerify(ctx, DEPLOYED)).toMatchObject({
      migrations: {
        evidence: "unavailable",
        reason: "verify stopped before reading the app's deployment",
      },
      ok: false,
    });
  });

  test("a committed migration whose SQL file is missing fails before any API call", async () => {
    const { ctx, lakebase, requests } = deployedApp({
      migrations: [{ tag: "0000_migration", when: 1000 }],
    });
    fs.rmSync(path.join(ctx.root, MIGRATIONS, "0000_migration.sql"));

    await expect(runVerify(ctx, DEPLOYED)).rejects.toThrow(
      /^Missing .*0000_migration\.sql, listed in meta\/_journal\.json\. Restore it from version control\.$/,
    );
    expect(requests).toEqual([]);
    expect(lakebase.calls).toEqual([]);
  });

  test.each([
    ["has no journal", "missing", [`workspace.get-status ${SNAPSHOT}`]],
    ["has a journal without entries", [], []],
  ] as const)(
    "without committed migrations, a snapshot that %s passes, and schema.ts is not needed",
    async (_label, deployedJournal, statusRequests) => {
      const { ctx, requests } = deployedApp({
        deployedJournal: deployedJournal as Migration[] | string,
      });
      fs.rmSync(path.join(ctx.root, "config/database/schema.ts"));

      expect(await runVerify(ctx, DEPLOYED)).toMatchObject({
        migrations: null,
        ok: true,
      });
      expect(requests).toEqual([
        "apps.get my-app",
        `workspace.export ${JOURNAL}`,
        ...statusRequests,
      ]);
    },
  );

  test.each([
    [
      "does not exist",
      "missing",
      `the source snapshot ${SNAPSHOT} does not exist`,
    ],
    [
      "has a status verify cannot read",
      "unreadable",
      `reading the status of ${SNAPSHOT} failed: Permission denied`,
    ],
  ] as const)(
    "without committed migrations, a journal 404 in a snapshot that %s is unavailable, not a pass",
    async (_label, snapshot, reason) => {
      const { ctx } = deployedApp({ deployedJournal: "missing", snapshot });

      expect(await runVerify(ctx, DEPLOYED)).toMatchObject({
        migrations: { evidence: "unavailable", reason },
        problems: [
          `verify cannot tell whether app my-app's active deployment has the committed migrations: ${reason}`,
        ],
        ok: false,
      });
    },
  );

  test("without committed migrations, a snapshot with migrations fails, naming them: the checkout is behind", async () => {
    const { ctx } = deployedApp({
      deployedJournal: [{ tag: "0000_migration", when: 1000 }],
    });

    expect(await runVerify(ctx, DEPLOYED)).toMatchObject({
      migrations: {
        evidence: "unavailable",
        reason:
          "the deployment has 0000_migration, and this checkout commits none in config/database/migrations next to databricks.yml: pull it, then run verify again",
      },
      problems: [
        "verify cannot tell whether app my-app's active deployment has the committed migrations: the deployment has 0000_migration, and this checkout commits none in config/database/migrations next to databricks.yml: pull it, then run verify again",
      ],
      ok: false,
    });
  });

  test("a migration the deployment has and this checkout does not commit fails it", async () => {
    const migrations = [{ tag: "0000_migration", when: 1000 }];
    const { ctx } = deployedApp({
      migrations,
      deployedJournal: [...migrations, { tag: "0001_migration", when: 2000 }],
    });

    expect(await runVerify(ctx, DEPLOYED)).toMatchObject({
      migrations: {
        evidence: "differs",
        missing: [],
        changed: [],
        unknown: ["0001_migration"],
      },
      problems: [
        "app my-app's active deployment has 0001_migration, which this checkout does not commit: pull it, then run verify again",
      ],
      ok: false,
    });
  });

  test("a snapshot without a journal lacks every committed migration: deploy them", async () => {
    const { ctx } = deployedApp({
      migrations: [
        { tag: "0000_migration", when: 1000 },
        { tag: "0001_migration", when: 2000 },
      ],
      deployedJournal: "missing",
    });

    expect(await runVerify(ctx, DEPLOYED)).toMatchObject({
      migrations: {
        evidence: "differs",
        missing: ["0000_migration", "0001_migration"],
        changed: [],
        unknown: [],
      },
      problems: [
        "app my-app's active deployment does not have 0000_migration, 0001_migration, which this checkout commits: `databricks apps deploy` deploys them, and the app applies them on start",
      ],
      ok: false,
    });
  });

  test("--target checks that target's app, branch and host", async () => {
    const staging = "projects/p/branches/staging";
    const { ctx, lakebase } = deployedApp({
      yml: `${ymlWithHost()}  staging:
    workspace:
      host: ${HOST}
    variables:
      postgres_branch: ${staging}
      postgres_database: ${staging}/databases/db-1
`,
      app: runningApp({
        resources: [
          {
            postgres: {
              branch: staging,
              database: `${staging}/databases/db-1`,
              permission: "CAN_CONNECT_AND_CREATE",
            },
          },
        ],
      }),
    });
    lakebase.addBranch(staging);
    lakebase.addRole(staging, `dbrx-apps-${SP}`, SP);
    lakebase.databases.set(`${staging}/databases/db-1`, {
      name: `${staging}/databases/db-1`,
      status: { postgres_database: "appdb" },
    });

    expect(
      await runVerify(ctx, { deployed: true, target: "staging" }),
    ).toMatchObject({ target: "staging", branch: staging, ok: true });
  });

  test("an unknown target, or no default target, names the targets there are", async () => {
    const { ctx } = deployedApp();
    await expect(
      runVerify(ctx, { deployed: true, target: "prod" }),
    ).rejects.toThrow(
      "databricks.yml has no target prod; its targets are default.",
    );

    const twoTargets = deployedApp({
      yml: ymlWithHost().replace("    default: true\n", "") + "  prod: {}\n",
    });
    await expect(runVerify(twoTargets.ctx, DEPLOYED)).rejects.toThrow(
      "databricks.yml has no default target; pass --target with one of default, prod.",
    );
  });

  test("a shell authenticated against another workspace is refused before any API call", async () => {
    const { ctx, lakebase, requests } = deployedApp({
      authenticatedHost: "https://other.cloud.databricks.com",
    });

    await expect(runVerify(ctx, DEPLOYED)).rejects.toThrow(
      `Target default deploys to ${HOST}, but this shell is authenticated against https://other.cloud.databricks.com. Set DATABRICKS_CONFIG_PROFILE to a profile for ${HOST}, then rerun.`,
    );
    expect(requests).toEqual([]);
    expect(lakebase.calls).toEqual([]);
  });

  test("a branch that only variable-overrides.json sets is the one verify checks, as a deploy from this checkout uses it", async () => {
    // The target gives the variables no value; only the overrides file does.
    const yml = `${databricksYml(PRODUCTION, DATABASE).replace(
      / {4}variables:\n(?: {6}.*\n)+/,
      "",
    )}    workspace:\n      host: ${HOST}\n`;
    const { ctx } = deployedApp({ yml });
    await expect(runVerify(ctx, DEPLOYED)).rejects.toThrow(
      'No deploy branch: resources.apps.app.resources[0].postgres.branch in target default is "${var.postgres_branch}", which this checkout\'s files do not resolve to a branch.',
    );

    const overrides = path.join(
      ctx.root,
      ".databricks/bundle/default/variable-overrides.json",
    );
    fs.mkdirSync(path.dirname(overrides), { recursive: true });
    fs.writeFileSync(
      overrides,
      JSON.stringify({
        postgres_branch: PRODUCTION,
        postgres_database: DATABASE,
      }),
    );

    expect(await runVerify(ctx, DEPLOYED)).toMatchObject({
      branch: PRODUCTION,
      problems: [],
      ok: true,
    });
  });

  test("a branch variable-overrides.json sets is credited to that file when it is missing or the app is bound elsewhere", async () => {
    const staging = "projects/p/branches/staging";
    const { ctx, lakebase } = deployedApp();
    const overrides = path.join(
      ctx.root,
      ".databricks/bundle/default/variable-overrides.json",
    );
    fs.mkdirSync(path.dirname(overrides), { recursive: true });
    fs.writeFileSync(overrides, JSON.stringify({ postgres_branch: staging }));
    const source =
      "databricks.yml with .databricks/bundle/default/variable-overrides.json";

    expect(await runVerify(ctx, DEPLOYED)).toMatchObject({
      branch: staging,
      problems: [`${source} deploys to ${staging}, which does not exist`],
      ok: false,
    });

    lakebase.addBranch(staging);
    expect(await runVerify(ctx, DEPLOYED)).toMatchObject({
      branch: staging,
      problems: expect.arrayContaining([
        `app my-app uses branch ${PRODUCTION}, not ${staging} from ${source}: \`databricks apps deploy\` applies ${source}`,
      ]),
      ok: false,
    });
  });

  test("a host written without a scheme or with a trailing slash matches", async () => {
    const { ctx } = deployedApp({
      yml: ymlWithHost("acme.cloud.databricks.com/"),
    });
    expect((await runVerify(ctx, DEPLOYED)).ok).toBe(true);
  });

  test("an app that does not exist yet: deploy it", async () => {
    const { ctx, lakebase } = deployedApp({ app: "missing" });

    expect(await runVerify(ctx, DEPLOYED)).toMatchObject({
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
    const { ctx, lakebase } = deployedApp({ app: runningApp({ resources }) });

    expect(await deployProblems(ctx)).toEqual([problem]);
    expect(lakebase.calls).not.toContain(`listRoles ${PRODUCTION}`);
  });

  test("a service principal without a role on the branch", async () => {
    const { ctx } = deployedApp({ spRole: false });

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
    const { ctx } = deployedApp({ app: runningApp(overrides) });

    expect(await deployProblems(ctx)).toEqual([problem]);
  });

  test("a deploy branch or database that does not exist", async () => {
    const { ctx, lakebase } = deployedApp();
    lakebase.databases.clear();
    expect(await deployProblems(ctx)).toEqual([
      `databricks.yml binds database ${DATABASE}, which does not exist on production`,
    ]);

    lakebase.branches.clear();
    expect(await deployProblems(ctx)).toEqual([
      `databricks.yml deploys to ${PRODUCTION}, which does not exist`,
    ]);
  });

  test("an app name with a reference only a deploy resolves is reported before any API call; ${bundle.target} resolves", async () => {
    const unresolved = deployedApp({
      yml: ymlWithApps(
        `resources:\n  apps:\n    app:\n      name: "my-app-\${workspace.current_user.short_name}"\n      resources:\n        - name: postgres\n          postgres:\n            branch: \${var.postgres_branch}\n`,
      ),
    });
    expect(await deployProblems(unresolved.ctx)).toEqual([
      "databricks.yml names the app my-app-${workspace.current_user.short_name}, with a reference verify cannot resolve",
    ]);
    expect(unresolved.requests).toEqual([]);
    expect(unresolved.lakebase.calls).toEqual([]);

    const perTarget = deployedApp({
      yml: ymlWithApps(
        `resources:\n  apps:\n    app:\n      name: "my-\${bundle.target}"\n      resources:\n        - name: postgres\n          postgres:\n            branch: \${var.postgres_branch}\n`,
      ),
      app: "missing",
    });
    await runVerify(perTarget.ctx, DEPLOYED);
    expect(perTarget.requests).toEqual(["apps.get my-default"]);
  });

  test("a target without an app, or with several apps on postgres, says so", async () => {
    const none = deployedApp({ yml: ymlWithApps("") });
    expect(await runVerify(none.ctx, DEPLOYED)).toMatchObject({
      app: null,
      problems: ["target default in databricks.yml declares no app"],
      ok: false,
    });
    expect(none.requests).toEqual([]);

    const postgres =
      "      resources:\n        - name: postgres\n          postgres:\n            branch: ${var.postgres_branch}\n";
    const several = deployedApp({
      yml: ymlWithApps(
        `resources:\n  apps:\n    web:\n      name: web\n${postgres}    worker:\n      name: worker\n${postgres}`,
      ),
    });
    await expect(runVerify(several.ctx, DEPLOYED)).rejects.toThrow(
      "Target default deploys 2 apps with a postgres resource (web, worker); verify checks one app per target.",
    );
  });

  test("an app with two postgres resources, or a branch or database the files do not resolve, is refused before any API call", async () => {
    const postgres = (branch: string, database: string) =>
      `        - name: postgres\n          postgres:\n            branch: ${branch}\n            database: ${database}\n`;
    const app = (resources: string) =>
      ymlWithApps(
        `resources:\n  apps:\n    app:\n      name: my-app\n      resources:\n${resources}`,
      );
    const cases = [
      [
        app(
          postgres("${var.postgres_branch}", "${var.postgres_database}") +
            postgres(
              "${var.postgres_branch}",
              "${var.postgres_database}",
            ).replace("name: postgres", "name: other"),
        ),
        "App app in target default has 2 postgres resources (resources.apps.app.resources[0].postgres, resources.apps.app.resources[1].postgres); verify checks one per app.",
      ],
      [
        app(postgres("${var.missing}", "${var.postgres_database}")),
        'No deploy branch: resources.apps.app.resources[0].postgres.branch in target default is "${var.missing}", which this checkout\'s files do not resolve to a branch.',
      ],
      [
        app(postgres("${var.postgres_branch}", "${var.missing}")),
        'No deploy database: resources.apps.app.resources[0].postgres.database in target default is "${var.missing}", which this checkout\'s files do not resolve to a database.',
      ],
    ];
    for (const [yml, message] of cases) {
      const { ctx, lakebase, requests } = deployedApp({ yml });
      await expect(runVerify(ctx, DEPLOYED)).rejects.toThrow(message);
      expect(requests).toEqual([]);
      expect(lakebase.calls).toEqual([]);
    }
  });

  test("an error other than 404 from the apps API names the app", async () => {
    const { ctx } = deployedApp({
      app: Object.assign(new Error("Forbidden"), { statusCode: 403 }),
    });

    await expect(runVerify(ctx, DEPLOYED)).rejects.toThrow(
      "Could not read app my-app: Forbidden",
    );
  });

  test("never writes and never connects to the database", async () => {
    const { ctx, lakebase } = deployedApp({ spRole: false });

    await runVerify(ctx, DEPLOYED);

    expect(withBranchPool).not.toHaveBeenCalled();
    expect(lakebase.calls.filter((c) => !/^(get|list)[A-Z]/.test(c))).toEqual(
      [],
    );
  });

  test("without databricks.yml, or without a postgres binding in it, it says so", async () => {
    const { ctx } = deployedApp();
    fs.writeFileSync(
      path.join(ctx.root, "databricks.yml"),
      "resources:\n  apps:\n    app:\n      name: my-app\n",
    );
    await expect(runVerify(ctx, DEPLOYED)).rejects.toThrow(
      "No deploy branch: target default in databricks.yml declares no app with a postgres resource.",
    );

    fs.rmSync(path.join(ctx.root, "databricks.yml"));
    await expect(runVerify(ctx, DEPLOYED)).rejects.toThrow(
      "No databricks.yml, so there is no deployed app to verify.",
    );
  });
});
