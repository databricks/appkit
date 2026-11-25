import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { resolveEnvBranch, withBranchPool, writableEnvBranch } = vi.hoisted(
  () => ({
    resolveEnvBranch: vi.fn(),
    withBranchPool: vi.fn(),
    writableEnvBranch: vi.fn(),
  }),
);

vi.mock("../guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../guard")>()),
  resolveEnvBranch,
  writableEnvBranch,
}));
vi.mock("../context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../context")>()),
  withBranchPool,
}));

import { deleteSessionBranch, previewClean, runClean } from "../clean";
import { withHistoryLock } from "../history-lock";
import { runSeed, SEED_FILE } from "../seed";
import { cleanupTempApps, FakeLakebase, fakeContext, tempApp } from "./fakes";

const builder = path.resolve(
  import.meta.dirname,
  "../../schema-builder/index.ts",
);
const schemaFile = (schemaName: string) =>
  `import { defineSchema, id } from ${JSON.stringify(builder)};
   export const schema = defineSchema(({ table }) => ({ notes: table("notes", { id: id() }) }), { schemaName: ${JSON.stringify(schemaName)} });`;

const DEPENDENTS = /pg_catalog\.pg_depend/;
const ME = "alice@example.com";
const SCHEMA_OWNER = /has_schema_privilege/;
const JOURNAL = /c\.relname = \$2/;
const TAG = /where hash = \$1/;
const KEPT_IN_PUBLIC = /nspname = 'public'/;

/**
 * A pool whose one client records statements, can fail on one, and answers
 * the dependents query. The app schema is yours unless `schemaOwner` names
 * another role. The reads of the schema's state are answered, not recorded.
 */
function recordingPool(
  options: {
    failOn?: RegExp;
    dependents?: string[];
    schemaOwner?: string;
  } = {},
) {
  const statements: string[] = [];
  const client = {
    released: undefined as { error: unknown } | undefined,
    async query(text: string) {
      if (SCHEMA_OWNER.test(text)) {
        return {
          rows: [
            {
              owner: options.schemaOwner ?? ME,
              can_create: true,
              current_user: ME,
            },
          ],
        };
      }
      if (JOURNAL.test(text)) {
        return {
          rows: [
            {
              relkind: "r",
              owner: ME,
              schema_owner: ME,
              current_user: ME,
              row_security: false,
              trusted: true,
            },
          ],
        };
      }
      if (TAG.test(text) || KEPT_IN_PUBLIC.test(text)) return { rows: [] };
      statements.push(DEPENDENTS.test(text) ? "<dependents>" : text);
      if (options.failOn?.test(text)) throw new Error("boom");
      return {
        rows: DEPENDENTS.test(text)
          ? (options.dependents ?? []).map((label) => ({ label }))
          : [],
      };
    },
    release(error?: unknown) {
      client.released = { error };
    },
  };
  const pool = {
    connect: vi.fn(async () => client),
    query: (text: string) => client.query(text),
  };
  withBranchPool.mockImplementation((_ctx, fn: (p: unknown) => unknown) =>
    fn(pool),
  );
  return { pool, client, statements };
}

const devBranch = { name: "projects/p/branches/dev-alice-3f9a2c" };
const refusal = (action: string) =>
  new Error(
    `Refusing to ${action}: production is not your dev or session branch (it is the project's default branch).`,
  );

beforeEach(() => {
  resolveEnvBranch.mockReset();
  withBranchPool.mockReset();
  writableEnvBranch.mockReset();
});
afterEach(cleanupTempApps);

describe("runClean", () => {
  test("drops the app schema in one transaction on your branch and reports what CASCADE removed outside it", async () => {
    const ctx = fakeContext({
      root: tempApp({ "config/database/schema.ts": schemaFile("app") }),
    });
    writableEnvBranch.mockResolvedValue(devBranch);
    const { client, statements } = recordingPool({
      dependents: ["view reporting.recent"],
    });

    await expect(runClean(ctx)).resolves.toEqual({
      branch: devBranch.name,
      schemaName: "app",
      dependents: ["view reporting.recent"],
      kept: [],
    });
    expect(writableEnvBranch).toHaveBeenCalledWith(ctx, "clean");
    expect(statements).toEqual([
      "begin",
      "<dependents>",
      `DROP SCHEMA IF EXISTS "app" CASCADE`,
      "commit",
    ]);
    expect(client.released).toEqual({ error: undefined });
  });

  test("without schema.ts it points to introspect before checking the branch", async () => {
    const ctx = fakeContext({ root: tempApp() });

    await expect(runClean(ctx)).rejects.toThrow(
      "No config/database/schema.ts yet, so clean cannot tell which schema to drop. Run `appkit db introspect` to write it from the branch's tables, or create it.",
    );
    expect(writableEnvBranch).not.toHaveBeenCalled();
    expect(withBranchPool).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(ctx.root, "config/database"))).toBe(false);
  });

  test("refuses a branch that is not yours before connecting", async () => {
    const ctx = fakeContext({
      root: tempApp({ "config/database/schema.ts": schemaFile("app") }),
    });
    writableEnvBranch.mockRejectedValue(refusal("clean"));

    await expect(runClean(ctx)).rejects.toThrow(/^Refusing to clean: /);
    expect(withBranchPool).not.toHaveBeenCalled();
  });

  test("a failing statement rolls back and discards the connection", async () => {
    const ctx = fakeContext({
      root: tempApp({ "config/database/schema.ts": schemaFile("app") }),
    });
    writableEnvBranch.mockResolvedValue(devBranch);
    const { client, statements } = recordingPool({ failOn: /DROP SCHEMA/ });

    await expect(runClean(ctx)).rejects.toThrow("boom");
    expect(statements.slice(-1)).toEqual(["rollback"]);
    expect(client.released?.error).toBeInstanceOf(Error);
  });

  test("while another appkit db command changes the migration history, it refuses before checking the branch", async () => {
    const root = tempApp({ "config/database/schema.ts": schemaFile("app") });
    const ctx = fakeContext({ root });

    await withHistoryLock(root, "migrate", async () => {
      await expect(runClean(ctx)).rejects.toThrow(
        /^Another `appkit db migrate` \(pid \d+ on .+\) is changing the migration history in config\/database\. /,
      );
    });
    expect(writableEnvBranch).not.toHaveBeenCalled();
    expect(withBranchPool).not.toHaveBeenCalled();
  });
});

describe("clean on the fork's untouched copy", () => {
  const untouched =
    'Refusing to clean: dev-alice-3f9a2c still holds the rows the fork copied into schema "app", which "app-sp" still owns, so your role cannot drop it. Run `appkit db init` to take it over and rebuild it from the committed migrations.';

  test("runClean refuses before dropping anything, and says to run init", async () => {
    const ctx = fakeContext({
      root: tempApp({ "config/database/schema.ts": schemaFile("app") }),
    });
    writableEnvBranch.mockResolvedValue(devBranch);
    const { statements } = recordingPool({ schemaOwner: "app-sp" });

    await expect(runClean(ctx)).rejects.toThrow(untouched);
    expect(statements.some((text) => text.includes("DROP"))).toBe(false);
  });

  test("previewClean refuses too, so the CLI does not ask first", async () => {
    const ctx = fakeContext({
      root: tempApp({ "config/database/schema.ts": schemaFile("app") }),
    });
    writableEnvBranch.mockResolvedValue(devBranch);
    recordingPool({ schemaOwner: "app-sp" });

    await expect(previewClean(ctx)).rejects.toThrow(untouched);
  });
});

describe("catalog text in clean and seed", () => {
  test("control characters in catalog names are escaped before they reach the terminal", async () => {
    const ctx = fakeContext({
      root: tempApp({ "config/database/schema.ts": schemaFile("app") }),
    });
    writableEnvBranch.mockResolvedValue(devBranch);
    recordingPool({ dependents: ['view reporting."a\u001b[2Jb"'] });

    await expect(runClean(ctx)).resolves.toMatchObject({
      dependents: ['view reporting."a\\u001b[2Jb"'],
    });

    const root = tempApp({ [SEED_FILE]: "select 1;" });
    recordingPool({ schemaOwner: "sp\nFAKE: done" });
    await expect(runSeed(fakeContext({ root }))).rejects.toThrow(
      'which "sp\\u000aFAKE: done" still owns',
    );
  });
});

describe("previewClean", () => {
  test("reads the dependents without opening a transaction or dropping anything", async () => {
    const ctx = fakeContext({
      root: tempApp({ "config/database/schema.ts": schemaFile("app") }),
    });
    writableEnvBranch.mockResolvedValue(devBranch);
    const { statements } = recordingPool({
      dependents: ["constraint refs_fk on table reporting.refs"],
    });

    await expect(previewClean(ctx)).resolves.toEqual({
      branch: devBranch.name,
      schemaName: "app",
      dependents: ["constraint refs_fk on table reporting.refs"],
      kept: [],
    });
    expect(statements).toEqual(["<dependents>"]);
  });
});

describe("deleteSessionBranch", () => {
  const session = {
    branch: { name: "projects/p/branches/session-abc123-x1" },
    kind: "session",
  };

  test("deletes this checkout's session branch", async () => {
    const lakebase = new FakeLakebase();
    lakebase.addBranch(session.branch.name);
    resolveEnvBranch.mockResolvedValue(session);

    await expect(
      deleteSessionBranch(
        fakeContext({ root: tempApp(), api: lakebase.api() }),
      ),
    ).resolves.toEqual({ branch: session.branch.name });
    expect(lakebase.calls).toEqual([`deleteBranch ${session.branch.name}`]);
  });

  test("keeps your dev branch and says how to delete it", async () => {
    resolveEnvBranch.mockResolvedValue({ branch: devBranch, kind: "dev" });

    await expect(
      deleteSessionBranch(fakeContext({ root: tempApp() })),
    ).rejects.toThrow(
      `Refusing to delete dev-alice-3f9a2c: --delete-branch deletes session branches only, and your dev branch stays for the next \`appkit db init\`. Delete it with \`databricks postgres delete-branch ${devBranch.name}\`.`,
    );
  });

  test("refuses any other branch, and a .env without one", async () => {
    resolveEnvBranch.mockResolvedValueOnce({
      branch: { name: "projects/p/branches/production" },
      kind: "default",
      reason: "it is the project's default branch",
    });
    const ctx = fakeContext({ root: tempApp() });

    await expect(deleteSessionBranch(ctx)).rejects.toThrow(
      "Refusing to delete the branch: production is not your dev or session branch (it is the project's default branch).",
    );
    resolveEnvBranch.mockResolvedValueOnce(null);
    await expect(deleteSessionBranch(ctx)).rejects.toThrow(
      /^Did not delete the branch: no branch is configured in \.env/,
    );
  });
});

test.each([
  ["clean", runClean],
  ["seed", runSeed],
])(
  "%s keeps the import error of a schema.ts that fails to import, for the CLI to show",
  async (_command, run) => {
    const root = tempApp({
      [SEED_FILE]: "select 1;",
      "config/database/schema.ts": "export const schema = (",
    });
    writableEnvBranch.mockResolvedValue(devBranch);

    const error = (await run(fakeContext({ root })).catch(
      (caught: unknown) => caught,
    )) as Error;

    expect((error.cause as Error).message).toMatch(/schema\.ts:\d+:\d+/);
  },
);

describe("runSeed", () => {
  test("runs config/database/seed.sql in one transaction on your branch, app schema first", async () => {
    const sql =
      "insert into app.notes default values;\ninsert into app.notes default values;\n";
    const root = tempApp({ [SEED_FILE]: sql });
    writableEnvBranch.mockResolvedValue(devBranch);
    const { statements } = recordingPool();

    await expect(runSeed(fakeContext({ root }))).resolves.toEqual({
      branch: devBranch.name,
      file: path.join(root, SEED_FILE),
    });
    expect(writableEnvBranch).toHaveBeenCalledWith(expect.anything(), "seed");
    expect(statements).toEqual([
      "begin",
      'SET LOCAL search_path TO "app", public',
      sql,
      "commit",
    ]);
  });

  test("refuses a branch whose app schema is still the fork's untouched copy, before running the file", async () => {
    const root = tempApp({ [SEED_FILE]: "insert into notes default values;" });
    writableEnvBranch.mockResolvedValue(devBranch);
    const { statements } = recordingPool({ schemaOwner: "app-sp" });

    await expect(runSeed(fakeContext({ root }))).rejects.toThrow(
      'Refusing to seed: dev-alice-3f9a2c still holds the rows the fork copied into schema "app", which "app-sp" still owns. Run `appkit db init` to rebuild it from the committed migrations, or `appkit db init --schema migrate` to keep them.',
    );
    expect(statements).toEqual(["begin", "rollback"]);
  });

  test.each([
    ["sales", 'SET LOCAL search_path TO "sales", public'],
    ["public", "SET LOCAL search_path TO public"],
  ])(
    "with schema.ts on %s, unqualified names resolve there",
    async (schemaName, searchPath) => {
      const root = tempApp({
        [SEED_FILE]: "insert into notes default values;",
        "config/database/schema.ts": schemaFile(schemaName),
      });
      writableEnvBranch.mockResolvedValue(devBranch);
      const { statements } = recordingPool();

      await runSeed(fakeContext({ root }));

      expect(statements.slice(0, 2)).toEqual(["begin", searchPath]);
    },
  );

  test("a missing seed file is an error, before any API call", async () => {
    await expect(runSeed(fakeContext({ root: tempApp() }))).rejects.toThrow(
      "No seed file at config/database/seed.sql",
    );
    expect(writableEnvBranch).not.toHaveBeenCalled();
  });

  test("refuses a branch that is not yours before connecting", async () => {
    const root = tempApp({ [SEED_FILE]: "select 1;" });
    writableEnvBranch.mockRejectedValue(refusal("seed"));

    await expect(runSeed(fakeContext({ root }))).rejects.toThrow(
      /^Refusing to seed: /,
    );
    expect(withBranchPool).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, SEED_FILE))).toBe(true);
  });
});
