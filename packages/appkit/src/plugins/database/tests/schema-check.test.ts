import { describe, expect, test, vi } from "vitest";

import type { DataPath } from "../../../database/runtime";
import { defineSchema, fk, id, text } from "../../../database/schema-builder";
import { assertSchemaMatchesDatabase } from "../schema-check";

const schema = defineSchema(({ table }) => {
  const boards = table("boards", { id: id(), title: text().notNull() });
  const notes = table("notes", {
    id: id(),
    board_id: fk(() => boards.id).notNull(),
    author_email: text().private(),
    body: text().notNull(),
  });
  return { boards, notes };
});

type CatalogRow = { table_name: string; column_name: string | null };

/** Answer the catalog query with the given tables and columns. */
function catalog(tables: Record<string, string[]>) {
  const rows: CatalogRow[] = Object.entries(tables).flatMap(
    ([name, columns]): CatalogRow[] =>
      columns.length === 0
        ? [{ table_name: name, column_name: null }]
        : columns.map((column) => ({ table_name: name, column_name: column })),
  );
  const raw = vi.fn(async () => rows);
  return { raw, path: { raw } as unknown as DataPath };
}

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
