import { describe, expect, test, vi } from "vitest";

import type { DataPath } from "../../../database/runtime";
import { defineSchema, fk, id, text } from "../../../database/schema-builder";
import { assertSchemaMatchesDatabase } from "../schema-check";

// Explicitly public: the assertions name the tables public.boards and public.notes.
const schema = defineSchema(
  ({ table }) => {
    const boards = table("boards", { id: id(), title: text().notNull() });
    const notes = table("notes", {
      id: id(),
      board_id: fk(() => boards.id).notNull(),
      author_email: text().private(),
      body: text().notNull(),
    });
    return { boards, notes };
  },
  { schemaName: "public" },
);

type CatalogRow = {
  table_name: string;
  column_name: string | null;
  relation_kind: string;
};

/** Answer the catalog query with the given tables and columns, and the lookup in public with `inPublic`. */
function catalog(
  tables: Record<string, string[]>,
  kinds: Record<string, string> = {},
  inPublic: string[] = [],
) {
  const rows: CatalogRow[] = Object.entries(tables).flatMap(
    ([name, columns]): CatalogRow[] =>
      columns.length === 0
        ? [
            {
              table_name: name,
              column_name: null,
              relation_kind: kinds[name] ?? "r",
            },
          ]
        : columns.map((column) => ({
            table_name: name,
            column_name: column,
            relation_kind: kinds[name] ?? "r",
          })),
  );
  const raw = vi.fn(async (strings: TemplateStringsArray) =>
    strings.join("?").includes("n.nspname = 'public'")
      ? inPublic.map((table_name) => ({ table_name }))
      : rows,
  );
  return { raw, path: { raw } as unknown as DataPath };
}

describe("assertSchemaMatchesDatabase — tables left in public", () => {
  const appSchema = defineSchema(({ table }) => ({
    boards: table("boards", { id: id() }),
    notes: table("notes", { id: id() }),
  }));

  test("every missing table is in public: says so and how to keep them there, not to migrate", async () => {
    const { path } = catalog({}, {}, ["boards", "notes"]);

    const error = await assertSchemaMatchesDatabase(path, appSchema).catch(
      (caught) => caught,
    );

    expect(error.message).toContain("table app.boards does not exist");
    expect(error.message).toContain(
      `Schema public has those tables, but defineSchema() puts tables in schema "app" unless told otherwise. ` +
        'To keep them in public, pass { schemaName: "public" } as the second argument of defineSchema()',
    );
    expect(error.message).not.toContain("commit migrations");
  });

  test("only some missing tables are in public: the usual advice", async () => {
    const { path } = catalog({}, {}, ["boards"]);

    await expect(assertSchemaMatchesDatabase(path, appSchema)).rejects.toThrow(
      "commit migrations under config/database/migrations",
    );
  });

  test("a schema declared as public never looks in public twice", async () => {
    const { raw, path } = catalog({ boards: ["id", "title"] });

    await expect(assertSchemaMatchesDatabase(path, schema)).rejects.toThrow(
      "commit migrations",
    );
    expect(raw).toHaveBeenCalledTimes(1);
  });
});

describe("assertSchemaMatchesDatabase", () => {
  test("accepts a database with every declared column, and extra ones", async () => {
    const { path } = catalog({
      boards: ["id", "title", "archived_at"],
      notes: ["id", "board_id", "author_email", "body"],
    });
    await expect(
      assertSchemaMatchesDatabase(path, schema),
    ).resolves.toBeUndefined();
  });

  test("names every missing table and column in one setup failure", async () => {
    // The shape a same-named table from another app leaves behind.
    const { path } = catalog({ notes: ["id", "case_id", "author", "content"] });

    const error = await assertSchemaMatchesDatabase(path, schema).catch(
      (caught) => caught,
    );

    expect(error).toMatchObject({ category: "SETUP_FAILED", phase: "setup" });
    expect(error.message).toContain("table public.boards does not exist");
    expect(error.message).toContain(
      "table public.notes is missing columns board_id, author_email, body",
    );
    // Only the stable message crosses a request boundary.
    expect(error.clientMessage).toBe("Database setup failed");
  });

  test("uses the singular for one missing column", async () => {
    const { path } = catalog({
      boards: ["id", "title"],
      notes: ["id", "board_id", "body"],
    });
    await expect(assertSchemaMatchesDatabase(path, schema)).rejects.toThrow(
      "table public.notes is missing column author_email",
    );
  });

  test("reports a table with no readable columns as missing them all", async () => {
    const { path } = catalog({
      boards: [],
      notes: ["id", "board_id", "author_email", "body"],
    });
    await expect(assertSchemaMatchesDatabase(path, schema)).rejects.toThrow(
      "table public.boards is missing columns id, title",
    );
  });

  test.each([
    ["v", "view"],
    ["m", "materialized view"],
    ["f", "foreign table"],
  ])(
    "rejects %s as a CRUD table even when all columns exist",
    async (kind, description) => {
      const { path } = catalog(
        {
          boards: ["id", "title"],
          notes: ["id", "board_id", "author_email", "body"],
        },
        { boards: kind },
      );

      await expect(assertSchemaMatchesDatabase(path, schema)).rejects.toThrow(
        `public.boards is a ${description}, not a table`,
      );
    },
  );

  test("passes the schema and table names as parameter values", async () => {
    const scoped = defineSchema(
      ({ table }) => ({ tags: table("tags", { id: id() }) }),
      { schemaName: "playground" },
    );
    const { raw, path } = catalog({ tags: ["id"] });

    await assertSchemaMatchesDatabase(path, scoped);

    expect(raw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = raw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(strings.join("?")).toContain("pg_catalog.pg_attribute");
    expect(strings.join("?")).toContain("c.relkind::text as relation_kind");
    expect(values).toEqual(["playground", ["tags"]]);
  });

  test("skips the catalog query for an empty schema", async () => {
    const { raw, path } = catalog({});
    await assertSchemaMatchesDatabase(
      path,
      defineSchema(() => ({})),
    );
    expect(raw).not.toHaveBeenCalled();
  });
});
