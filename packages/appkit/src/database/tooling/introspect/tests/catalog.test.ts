import { describe, expect, test } from "vitest";

import { buildTables, readCatalog } from "../catalog";
import { catalogResponder, catalogRows } from "./fixture";

describe("readCatalog", () => {
  test("maps catalog rows to tables, columns, keys, foreign keys and enums", async () => {
    const { respond } = catalogResponder();
    const [authors, posts] = await readCatalog(respond, "app");

    expect(authors).toEqual({
      name: "authors",
      partitioned: false,
      primaryKey: ["id"],
      unique: [{ name: "authors_email_key", columns: ["email"] }],
      foreignKeys: [],
      checks: [],
      indexes: [],
      columns: [
        {
          name: "id",
          type: "integer",
          notNull: true,
          identity: "",
          generated: false,
          defaultExpr: "nextval('app.authors_id_seq'::regclass)",
        },
        {
          name: "email",
          type: "character varying(255)",
          notNull: true,
          identity: "",
          generated: false,
          defaultExpr: null,
        },
        {
          name: "created_at",
          type: "timestamp with time zone",
          notNull: true,
          identity: "",
          generated: false,
          defaultExpr: "now()",
        },
      ],
    });
    expect(posts?.primaryKey).toEqual(["id"]);
    expect(posts?.foreignKeys).toEqual([
      {
        name: "posts_author_id_fkey",
        columns: ["author_id"],
        schema: "app",
        table: "authors",
        refColumns: ["id"],
        onDelete: "cascade",
        onUpdate: "no action",
        deferrable: false,
        matchFull: false,
      },
    ]);
    expect(posts?.indexes).toEqual(["posts_status_idx"]);
    expect(posts?.columns.find((c) => c.name === "id")?.identity).toBe("d");
    expect(posts?.columns.find((c) => c.name === "total")?.generated).toBe(
      true,
    );
    expect(posts?.columns.find((c) => c.name === "status")?.enum).toEqual({
      name: "ticket_status",
      schema: "app",
      values: ["open", "closed"],
    });
  });

  test("partitioned tables, CHECK and EXCLUDE constraints, indexes, DEFERRABLE and MATCH FULL are kept for the report", () => {
    const row = (kind: "c" | "x" | "f", name: string, extra = {}) => ({
      ...catalogRows.constraints[2],
      kind,
      name,
      ...extra,
    });
    const [table] = buildTables(
      [{ name: "posts", partitioned: true }],
      [],
      [
        row("c", "posts_score_check"),
        row("x", "posts_no_overlap"),
        row("f", "posts_author_id_fkey", {
          deferrable: true,
          match_type: "f",
        }),
      ] as never,
      [
        { table_name: "posts", name: "posts_status_idx" },
        { table_name: "authors", name: "authors_name_idx" },
      ],
    );
    expect(table).toMatchObject({
      partitioned: true,
      checks: ["posts_score_check", "posts_no_overlap"],
      indexes: ["posts_status_idx"],
      foreignKeys: [{ deferrable: true, matchFull: true }],
    });
  });

  test("stored and virtual (PG18) generated columns are both generated", () => {
    const [table] = buildTables(
      [{ name: "t", partitioned: false }],
      ["s", "v", ""].map((generated, i) => ({
        ...catalogRows.columns[0],
        table_name: "t",
        name: `c${i}`,
        generated,
      })) as never,
      [],
    );
    expect(table?.columns.map((c) => c.generated)).toEqual([true, true, false]);
  });

  test("referential action letters map to builder actions", () => {
    const fkRow = (on_delete: string, on_update: string) => ({
      ...catalogRows.constraints[2],
      on_delete,
      on_update,
    });
    const [table] = buildTables(
      [{ name: "posts", partitioned: false }],
      [],
      ["r", "c", "n", "d", "a"].map((letter) => fkRow(letter, letter)) as never,
    );
    expect(table?.foreignKeys.map((fk) => [fk.onDelete, fk.onUpdate])).toEqual([
      ["restrict", "restrict"],
      ["cascade", "cascade"],
      ["set null", "set null"],
      ["set default", "set default"],
      ["no action", "no action"],
    ]);
  });
});
