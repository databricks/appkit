import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { type Journal, readJournal } from "../../migrations/paths";
import { defineSchema, id, text } from "../../schema-builder";
import { runCheck } from "../check";
import type { DbContext } from "../context";
import { generateMigrationFiles } from "../migrations";

const builder = path.resolve(
  import.meta.dirname,
  "../../schema-builder/index.ts",
);
const roots: string[] = [];

type Columns = Record<string, "id" | "text">;
type Tables = Record<string, Columns>;

function writeSchema(root: string, tables: Tables): void {
  const file = path.join(root, "config/database/schema.ts");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = Object.entries(tables)
    .map(
      ([name, columns]) =>
        `${name}: table(${JSON.stringify(name)}, { ${Object.entries(columns)
          .map(([column, type]) => `${column}: ${type}()`)
          .join(", ")} })`,
    )
    .join(", ");
  fs.writeFileSync(
    file,
    `import { defineSchema, id, text } from ${JSON.stringify(builder)};
     export const schema = defineSchema(({ table }) => ({ ${body} }));`,
  );
}

function schemaOf(tables: Tables) {
  return defineSchema(({ table }) =>
    Object.fromEntries(
      Object.entries(tables).map(([name, columns]) => [
        name,
        table(
          name,
          Object.fromEntries(
            Object.entries(columns).map(([column, type]) => [
              column,
              type === "id" ? id() : text(),
            ]),
          ),
        ),
      ]),
    ),
  );
}

function app(tables: Tables): DbContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "appkit-db-check-"));
  roots.push(root);
  writeSchema(root, tables);
  return {
    root,
    env: {},
    workspace: () => {
      throw new Error("no workspace calls expected");
    },
    api: () => {
      throw new Error("no Lakebase API calls expected");
    },
  };
}

function migrations(ctx: DbContext): string {
  return path.join(ctx.root, "config/database/migrations");
}

function generate(folder: string, tables: Tables) {
  return generateMigrationFiles({
    folder,
    schema: schemaOf(tables),
    interactive: false,
  });
}

function editJournal(folder: string, edit: (journal: Journal) => void): void {
  const journal = readJournal(folder);
  if (!journal) throw new Error("no journal");
  edit(journal);
  fs.writeFileSync(
    path.join(folder, "meta/_journal.json"),
    JSON.stringify(journal, null, 2),
  );
}

const notes: Tables = { notes: { id: "id", body: "text" } };
const withTags: Tables = { ...notes, tags: { id: "id", label: "text" } };
const withLikes: Tables = { ...notes, likes: { id: "id" } };

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("runCheck", () => {
  test("passes when the migrations are in order and schema.ts has none pending", async () => {
    const ctx = app(withTags);
    await generate(migrations(ctx), notes);
    await generate(migrations(ctx), withTags);

    expect(await runCheck(ctx)).toEqual({
      migrations: ["0000_migration", "0001_migration"],
      problems: [],
      ok: true,
    });
  });

  test("passes with no migrations while schema.ts declares no tables", async () => {
    const ctx = app({});

    expect(await runCheck(ctx)).toEqual({
      migrations: [],
      problems: [],
      ok: true,
    });
  });

  test("a schema.ts change without its migration fails", async () => {
    const ctx = app(withTags);
    await generate(migrations(ctx), notes);

    const report = await runCheck(ctx);

    expect(report.ok).toBe(false);
    expect(report.problems).toEqual([
      "config/database/schema.ts changed since 0000_migration, so the deployed app would not get the change. Run `appkit db migrate` and commit the migration it writes.",
    ]);
  });

  test("tables with no migration committed at all fail", async () => {
    const ctx = app(notes);

    expect((await runCheck(ctx)).problems).toEqual([
      "config/database/schema.ts changed and no migration is committed, so the deployed app would not get the change. Run `appkit db migrate` and commit the migration it writes.",
    ]);
  });

  test("a renamed column counts as a change, without prompting", async () => {
    const ctx = app({ notes: { id: "id", text: "text" } });
    await generate(migrations(ctx), notes);

    expect((await runCheck(ctx)).problems).toEqual([
      expect.stringContaining(
        "config/database/schema.ts changed since 0000_migration",
      ),
    ]);
  });

  test("two migrations generated from one snapshot on parallel branches fail", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const ctx = app({ ...withTags, ...withLikes });
    const main = migrations(ctx);
    const parallel = path.join(ctx.root, "parallel");
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    await generate(main, notes);
    fs.cpSync(main, parallel, { recursive: true });
    vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
    await generate(main, withTags);
    vi.setSystemTime(new Date("2026-10-03T00:00:00Z"));
    await generate(parallel, withLikes);

    // The merge keeps both, renumbering the parallel one after main's.
    fs.copyFileSync(
      path.join(parallel, "0001_migration.sql"),
      path.join(main, "0002_migration.sql"),
    );
    fs.copyFileSync(
      path.join(parallel, "meta/0001_snapshot.json"),
      path.join(main, "meta/0002_snapshot.json"),
    );
    const merged = readJournal(parallel)?.entries.at(-1);
    if (!merged) throw new Error("no parallel migration");
    editJournal(main, (journal) => {
      journal.entries.push({ ...merged, idx: 2, tag: "0002_migration" });
    });

    const report = await runCheck(ctx);

    expect(report.problems).toEqual([
      expect.stringContaining(
        "0002_migration was generated after 0000_migration, not after 0001_migration: they were written on parallel branches, so 0002_migration lacks the other's changes. Merge the base branch, reset the migrations to its own",
      ),
      "config/database/schema.ts changed since 0002_migration, so the deployed app would not get the change. Run `appkit db migrate` and commit the migration it writes.",
    ]);
  });

  test("a migration listed after a newer one fails, since a branch that ran the newer one skips it", async () => {
    const ctx = app(withTags);
    await generate(migrations(ctx), notes);
    await generate(migrations(ctx), withTags);
    editJournal(migrations(ctx), (journal) => {
      const [first, second] = journal.entries;
      if (first && second) second.when = first.when - 1;
    });

    expect((await runCheck(ctx)).problems).toEqual([
      expect.stringContaining(
        "0001_migration is listed after 0000_migration but was generated before it, so a branch that ran 0000_migration never runs 0001_migration.",
      ),
    ]);
  });

  test("an entry whose idx is not its position fails", async () => {
    const ctx = app(notes);
    await generate(migrations(ctx), notes);
    editJournal(migrations(ctx), (journal) => {
      const [first] = journal.entries;
      if (first) first.idx = 3;
    });
    fs.renameSync(
      path.join(migrations(ctx), "meta/0000_snapshot.json"),
      path.join(migrations(ctx), "meta/0003_snapshot.json"),
    );

    expect((await runCheck(ctx)).problems).toEqual([
      expect.stringContaining(
        "0000_migration is entry 0 of meta/_journal.json, but its idx is 3, so drizzle-kit reads another snapshot for it.",
      ),
    ]);
  });

  test("uncommitted and unlisted files fail, and the schema is not compared without the latest snapshot", async () => {
    const ctx = app({ ...withTags, extra: { id: "id" } });
    await generate(migrations(ctx), notes);
    await generate(migrations(ctx), withTags);
    fs.rmSync(path.join(migrations(ctx), "0000_migration.sql"));
    fs.rmSync(path.join(migrations(ctx), "meta/0001_snapshot.json"));
    fs.writeFileSync(
      path.join(migrations(ctx), "0001_parallel.sql"),
      "CREATE TABLE x ();",
    );

    expect((await runCheck(ctx)).problems).toEqual([
      `${path.join("config/database/migrations/meta/0001_snapshot.json")}, the snapshot of 0001_migration, is not committed. Restore it from version control: the next migration is generated from it.`,
      `${path.join("config/database/migrations/0000_migration.sql")} is listed in meta/_journal.json but not committed. Restore it from version control.`,
      expect.stringContaining(
        `${path.join("config/database/migrations/0001_parallel.sql")} is not in meta/_journal.json, so no deploy runs it.`,
      ),
    ]);
  });

  test("without schema.ts it points to introspect", async () => {
    const ctx = app({});
    fs.rmSync(path.join(ctx.root, "config/database/schema.ts"));

    await expect(runCheck(ctx)).rejects.toThrow(
      "No config/database/schema.ts yet, so there is nothing to check.",
    );
  });
});
