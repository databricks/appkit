import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { assertAppkitBranch, openBranchPool } = vi.hoisted(() => ({
  assertAppkitBranch: vi.fn(),
  openBranchPool: vi.fn(),
}));

vi.mock("../guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../guard")>()),
  assertAppkitBranch,
}));
vi.mock("../context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../context")>()),
  openBranchPool,
}));

import { runClean } from "../clean";
import { BranchGuardError } from "../guard";
import { runSeed, SEED_FILE } from "../seed";
import { cleanupTempApps, fakeContext, tempApp } from "./fakes";

const builder = path.resolve(
  import.meta.dirname,
  "../../schema-builder/index.ts",
);
const schemaFile = (schemaName: string) =>
  `import { defineSchema, id } from ${JSON.stringify(builder)};
   export const schema = defineSchema(({ table }) => ({ notes: table("notes", { id: id() }) }), { schemaName: ${JSON.stringify(schemaName)} });`;

/** A pool whose one client records statements and can fail on one of them. */
function recordingPool(failOn?: RegExp) {
  const statements: string[] = [];
  const client = {
    released: undefined as { error: unknown } | undefined,
    async query(text: string) {
      statements.push(text);
      if (failOn?.test(text)) throw new Error("boom");
      return { rows: [] };
    },
    release(error?: unknown) {
      client.released = { error };
    },
  };
  const pool = {
    connect: vi.fn(async () => client),
    end: vi.fn(async () => undefined),
  };
  return { pool, client, statements };
}

const devBranch = { name: "projects/p/branches/dev-alice-3f9a2c" };

beforeEach(() => {
  assertAppkitBranch.mockReset();
  openBranchPool.mockReset();
});
afterEach(cleanupTempApps);

describe("runClean", () => {
  test("drops the app schema in one transaction on an AppKit branch", async () => {
    const ctx = fakeContext({
      root: tempApp({ "config/database/schema.ts": schemaFile("app") }),
    });
    assertAppkitBranch.mockResolvedValue(devBranch);
    const { pool, client, statements } = recordingPool();
    openBranchPool.mockResolvedValue(pool);

    await expect(runClean(ctx)).resolves.toEqual({
      branch: devBranch.name,
      schemaName: "app",
    });
    expect(assertAppkitBranch).toHaveBeenCalledWith(ctx, "clean");
    expect(statements).toEqual([
      "BEGIN",
      `DROP SCHEMA IF EXISTS "app" CASCADE`,
      "COMMIT",
    ]);
    expect(client.released).toEqual({ error: undefined });
    expect(pool.end).toHaveBeenCalledOnce();
  });

  test("without schema.ts it points to introspect before checking the branch", async () => {
    const ctx = fakeContext({ root: tempApp() });

    await expect(runClean(ctx)).rejects.toThrow(
      "No config/database/schema.ts yet, so clean cannot tell which schema to drop. Run `appkit db introspect` to write it from the branch's tables, or create it.",
    );
    expect(assertAppkitBranch).not.toHaveBeenCalled();
    expect(openBranchPool).not.toHaveBeenCalled();
  });

  test("refuses a non-AppKit branch before connecting", async () => {
    const ctx = fakeContext({
      root: tempApp({ "config/database/schema.ts": schemaFile("app") }),
    });
    assertAppkitBranch.mockRejectedValue(
      new BranchGuardError(
        "clean",
        "projects/p/branches/production",
        "it is the project's default branch",
      ),
    );

    await expect(runClean(ctx)).rejects.toThrow(/Refusing to clean production/);
    expect(openBranchPool).not.toHaveBeenCalled();
  });

  test("a failing statement rolls back and discards the connection", async () => {
    const ctx = fakeContext({
      root: tempApp({ "config/database/schema.ts": schemaFile("app") }),
    });
    assertAppkitBranch.mockResolvedValue(devBranch);
    const { pool, client, statements } = recordingPool(/DROP SCHEMA/);
    openBranchPool.mockResolvedValue(pool);

    await expect(runClean(ctx)).rejects.toThrow("boom");
    expect(statements.slice(-1)).toEqual(["ROLLBACK"]);
    expect(client.released?.error).toBeInstanceOf(Error);
    expect(pool.end).toHaveBeenCalledOnce();
  });
});

describe("runSeed", () => {
  test("runs config/database/seed.sql in one transaction on an AppKit branch, app schema first", async () => {
    const sql =
      "insert into app.notes default values;\ninsert into app.notes default values;\n";
    const root = tempApp({ [SEED_FILE]: sql });
    assertAppkitBranch.mockResolvedValue(devBranch);
    const { pool, statements } = recordingPool();
    openBranchPool.mockResolvedValue(pool);

    await expect(runSeed(fakeContext({ root }))).resolves.toEqual({
      branch: devBranch.name,
      file: path.join(root, SEED_FILE),
    });
    expect(assertAppkitBranch).toHaveBeenCalledWith(expect.anything(), "seed");
    expect(statements).toEqual([
      "BEGIN",
      'SET LOCAL search_path TO "app", public',
      sql,
      "COMMIT",
    ]);
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
      assertAppkitBranch.mockResolvedValue(devBranch);
      const { pool, statements } = recordingPool();
      openBranchPool.mockResolvedValue(pool);

      await runSeed(fakeContext({ root }));

      expect(statements.slice(0, 2)).toEqual(["BEGIN", searchPath]);
    },
  );

  test("a missing seed file is an error, before any API call", async () => {
    await expect(runSeed(fakeContext({ root: tempApp() }))).rejects.toThrow(
      "No seed file at config/database/seed.sql",
    );
    expect(assertAppkitBranch).not.toHaveBeenCalled();
  });

  test("refuses a non-AppKit branch before connecting", async () => {
    const root = tempApp({ [SEED_FILE]: "select 1;" });
    assertAppkitBranch.mockRejectedValue(
      new BranchGuardError("seed", "projects/p/branches/staging", "nope"),
    );

    await expect(runSeed(fakeContext({ root }))).rejects.toThrow(
      /Refusing to seed staging/,
    );
    expect(openBranchPool).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, SEED_FILE))).toBe(true);
  });
});
