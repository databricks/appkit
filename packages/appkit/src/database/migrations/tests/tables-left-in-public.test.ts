import { describe, expect, test, vi } from "vitest";

import { defineSchema, id } from "../../schema-builder";
import {
  type CatalogSql,
  catalogSqlOf,
  detectTablesLeftInPublic,
  locateTables,
} from "../tables-left-in-public";

type PlacementRow = { schema_name: string; table_name: string };

/** A catalog that answers every lookup with the given (schema, table) rows. */
function catalog(rows: PlacementRow[]) {
  const sql = vi.fn(async () => rows) as unknown as CatalogSql;
  return { sql, calls: sql as unknown as ReturnType<typeof vi.fn> };
}

const implicit = defineSchema(({ table }) => ({
  boards: table("boards", { id: id() }),
  notes: table("notes", { id: id() }),
}));

describe("catalogSqlOf", () => {
  test("renders tagged SQL as numbered parameters and returns the rows", async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [{ n: 1 }] })),
    };
    const sql = catalogSqlOf(client);

    const rows = await sql`select ${"a"} as x, ${["b", "c"]}::text[] as y`;

    expect(rows).toEqual([{ n: 1 }]);
    expect(client.query).toHaveBeenCalledWith(
      "select $1 as x, $2::text[] as y",
      ["a", ["b", "c"]],
    );
  });
});

describe("locateTables", () => {
  test("reports each table under the schema it was found in, in declaration order", async () => {
    const { sql } = catalog([
      { schema_name: "public", table_name: "notes" },
      { schema_name: "app", table_name: "tags" },
      { schema_name: "public", table_name: "boards" },
    ]);

    const placement = await locateTables(sql, "app", [
      "boards",
      "notes",
      "tags",
    ]);

    expect(placement).toEqual({
      inSchema: ["tags"],
      inPublic: ["boards", "notes"],
    });
  });

  test("passes the schema and the table names as parameter values", async () => {
    const { sql, calls } = catalog([]);

    await locateTables(sql, "playground", ["tags"]);

    const [strings, ...values] = calls.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(strings.join("?")).toContain("pg_catalog.pg_class");
    expect(values).toEqual(["playground", ["tags"]]);
  });

  test("asks nothing for an empty table list", async () => {
    const { sql, calls } = catalog([]);

    await expect(locateTables(sql, "app", [])).resolves.toEqual({
      inSchema: [],
      inPublic: [],
    });
    expect(calls).not.toHaveBeenCalled();
  });
});

describe("detectTablesLeftInPublic", () => {
  test("the default schema, nothing in it, and the tables in public: the refusal names them and the fix", async () => {
    const { sql } = catalog([
      { schema_name: "public", table_name: "boards" },
      { schema_name: "public", table_name: "notes" },
    ]);

    const reason = await detectTablesLeftInPublic(sql, implicit);

    expect(reason).toContain(
      'none of the declared tables exist in schema "app", but public has boards, notes',
    );
    expect(reason).toContain(
      'pass { schemaName: "public" } as the second argument of defineSchema()',
    );
    expect(reason).toContain("ALTER TABLE public.<table> SET SCHEMA app");
    expect(reason).toContain('pass { schemaName: "app" } explicitly');
  });

  test("some declared tables in public, none in app: still refused, naming only those in public", async () => {
    const { sql } = catalog([{ schema_name: "public", table_name: "notes" }]);

    await expect(detectTablesLeftInPublic(sql, implicit)).resolves.toContain(
      "public has notes.",
    );
  });

  test.each([
    [
      "a declared table already in app",
      [
        { schema_name: "app", table_name: "boards" },
        { schema_name: "public", table_name: "notes" },
      ],
    ],
    ["a fresh database", []],
  ])("%s is migrated", async (_label, rows) => {
    const { sql } = catalog(rows);

    await expect(detectTablesLeftInPublic(sql, implicit)).resolves.toBe(
      undefined,
    );
  });

  test('schemaName "app" named explicitly is migrated without consulting the catalog', async () => {
    const explicit = defineSchema(
      ({ table }) => ({ notes: table("notes", { id: id() }) }),
      { schemaName: "app" },
    );
    const { sql, calls } = catalog([
      { schema_name: "public", table_name: "notes" },
    ]);

    await expect(detectTablesLeftInPublic(sql, explicit)).resolves.toBe(
      undefined,
    );
    expect(calls).not.toHaveBeenCalled();
  });

  test("a schema with no tables is migrated without consulting the catalog", async () => {
    const { sql, calls } = catalog([]);

    await expect(
      detectTablesLeftInPublic(
        sql,
        defineSchema(() => ({})),
      ),
    ).resolves.toBe(undefined);
    expect(calls).not.toHaveBeenCalled();
  });
});
