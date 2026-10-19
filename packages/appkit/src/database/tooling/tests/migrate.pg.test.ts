import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

const { resolveEnvBranch, withBranchPool } = vi.hoisted(() => ({
  resolveEnvBranch: vi.fn(),
  withBranchPool: vi.fn(),
}));

vi.mock("../guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../guard")>()),
  resolveEnvBranch,
}));
vi.mock("../context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../context")>()),
  withBranchPool,
}));

import type { DbContext } from "../context";
import { runMigrate } from "../migrate";

// drizzle-kit and the migrator against a real server: the branch guard and the
// Lakebase pool are replaced, nothing else. APPKIT_TEST_PG_URL points at a
// scratch database, e.g. postgres://localhost:5432/postgres
const url = process.env.APPKIT_TEST_PG_URL;
const builder = path.resolve(
  import.meta.dirname,
  "../../schema-builder/index.ts",
);

describe.skipIf(!url)("runMigrate against Postgres", () => {
  const schema = `migrate_${randomUUID().slice(0, 8)}`;
  let admin: Pool;
  let ctx: DbContext;

  const writeSchema = (columns: string) => {
    const file = path.join(ctx.root, "config/database/schema.ts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `import { defineSchema, id, text } from ${JSON.stringify(builder)};
       export const schema = defineSchema(
         ({ table }) => ({ notes: table("notes", { ${columns} }) }),
         { schemaName: ${JSON.stringify(schema)} },
       );`,
    );
  };
  const journalTags = () =>
    (
      JSON.parse(
        fs.readFileSync(
          path.join(ctx.root, "config/database/migrations/meta/_journal.json"),
          "utf-8",
        ),
      ) as { entries: { tag: string }[] }
    ).entries.map((entry) => entry.tag);

  beforeAll(() => {
    admin = new Pool({ connectionString: url, max: 1 });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "appkit-migrate-pg-"));
    ctx = {
      root,
      env: {},
      workspace: () => {
        throw new Error("no workspace calls expected");
      },
      api: () => {
        throw new Error("no Lakebase API calls expected");
      },
    };
    resolveEnvBranch.mockResolvedValue({
      branch: { name: "projects/p/branches/dev-alice-3f9a2c" },
      kind: "dev",
    });
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
    await admin.query(`drop schema if exists "${schema}" cascade`);
    await admin.end();
    fs.rmSync(ctx.root, { recursive: true, force: true });
  });

  test("a migration that fails on the branch's data is removed, and the fixed schema.ts applies", async () => {
    writeSchema("id: id(), body: text()");
    await expect(
      runMigrate(ctx, { interactive: false }),
    ).resolves.toMatchObject({ applied: ["0000_migration"] });
    await admin.query(`insert into "${schema}".notes (body) values ('kept')`);

    writeSchema("id: id(), body: text(), title: text().notNull()");
    const error = (await runMigrate(ctx, { interactive: false }).catch(
      (caught: unknown) => caught,
    )) as Error;
    expect(error.message).toMatch(
      /^Migration 0001_migration failed \(SQLSTATE 23502\) and was rolled back\. .*Removed .*0001_migration\.sql, so the next run writes it again/,
    );
    expect(journalTags()).toEqual(["0000_migration"]);

    writeSchema(
      'id: id(), body: text(), title: text().notNull().default("untitled")',
    );
    await expect(
      runMigrate(ctx, { interactive: false }),
    ).resolves.toMatchObject({ applied: ["0001_migration"] });
    expect(journalTags()).toEqual(["0000_migration", "0001_migration"]);
    const { rows } = await admin.query<{ body: string; title: string }>(
      `select body, title from "${schema}".notes`,
    );
    expect(rows).toEqual([{ body: "kept", title: "untitled" }]);
  });
});
