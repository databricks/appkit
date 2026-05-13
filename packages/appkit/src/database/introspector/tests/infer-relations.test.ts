import { describe, expect, test } from "vitest";
import { inferRelationsByConvention } from "../infer-relations";
import type { IntrospectedColumn, IntrospectedTable } from "../types";

function col(
  overrides: Partial<IntrospectedColumn> & { name: string },
): IntrospectedColumn {
  return {
    pgType: "text",
    nullable: false,
    hasDefault: false,
    ...overrides,
  };
}

function table(
  name: string,
  columns: IntrospectedColumn[],
  schema = "public",
): IntrospectedTable {
  return { schema, name, policies: [], columns };
}

describe("inferRelationsByConvention", () => {
  test("links a child column to a same-named PK on another table", () => {
    const tables = [
      table("cases", [col({ name: "case_id", isPrimaryKey: true })]),
      table("activity_log", [
        col({ name: "log_id", isPrimaryKey: true }),
        col({ name: "case_id" }),
      ]),
    ];

    inferRelationsByConvention(tables);

    expect(tables[1].columns[1].references).toEqual({
      schema: "public",
      table: "cases",
      column: "case_id",
      inferred: true,
    });
  });

  test("infers FK on a PK column that points elsewhere (1:1 mapping table)", () => {
    const tables = [
      table("cases", [col({ name: "case_id", isPrimaryKey: true })]),
      table("ai_summaries", [col({ name: "case_id", isPrimaryKey: true })]),
    ];

    inferRelationsByConvention(tables);

    expect(tables[1].columns[0].references).toEqual({
      schema: "public",
      table: "cases",
      column: "case_id",
      inferred: true,
    });
  });

  test("does not turn a canonical PK into an FK to a 1:1 table", () => {
    const tables = [
      table("cases", [col({ name: "case_id", isPrimaryKey: true })]),
      table("ai_summaries", [col({ name: "case_id", isPrimaryKey: true })]),
    ];

    inferRelationsByConvention(tables);

    expect(tables[0].columns[0].references).toBeUndefined();
  });

  test("breaks ambiguity by matching the table name to the column prefix", () => {
    const tables = [
      table("cases", [col({ name: "case_id", isPrimaryKey: true })]),
      table("ai_summaries", [col({ name: "case_id", isPrimaryKey: true })]),
      table("activity_log", [
        col({ name: "log_id", isPrimaryKey: true }),
        col({ name: "case_id" }),
      ]),
    ];

    inferRelationsByConvention(tables);

    expect(tables[2].columns[1].references).toEqual({
      schema: "public",
      table: "cases",
      column: "case_id",
      inferred: true,
    });
  });

  test("does not overwrite an existing declared FK", () => {
    const tables = [
      table("cases", [col({ name: "case_id", isPrimaryKey: true })]),
      table("activity_log", [
        col({ name: "log_id", isPrimaryKey: true }),
        col({
          name: "case_id",
          references: {
            schema: "other",
            table: "elsewhere",
            column: "case_id",
          },
        }),
      ]),
    ];

    inferRelationsByConvention(tables);

    expect(tables[1].columns[1].references).toEqual({
      schema: "other",
      table: "elsewhere",
      column: "case_id",
    });
  });

  test("skips when target PK type does not match", () => {
    const tables = [
      table("cases", [col({ name: "case_id", isPrimaryKey: true })]),
      table("activity_log", [
        col({ name: "log_id", isPrimaryKey: true }),
        col({ name: "case_id", pgType: "int4" }),
      ]),
    ];

    inferRelationsByConvention(tables);

    expect(tables[1].columns[1].references).toBeUndefined();
  });

  test("skips when ambiguity has no naming tiebreaker", () => {
    const tables = [
      table("alpha", [col({ name: "shared_id", isPrimaryKey: true })]),
      table("beta", [col({ name: "shared_id", isPrimaryKey: true })]),
      table("gamma", [
        col({ name: "id", isPrimaryKey: true }),
        col({ name: "shared_id" }),
      ]),
    ];

    inferRelationsByConvention(tables);

    expect(tables[2].columns[1].references).toBeUndefined();
  });

  test("matches simple plural and -ies plural", () => {
    const tables = [
      table("categories", [col({ name: "category_id", isPrimaryKey: true })]),
      table("addresses", [col({ name: "address_id", isPrimaryKey: true })]),
      table("orders", [
        col({ name: "order_id", isPrimaryKey: true }),
        col({ name: "category_id" }),
        col({ name: "address_id" }),
      ]),
    ];

    inferRelationsByConvention(tables);

    expect(tables[2].columns[1].references?.table).toBe("categories");
    expect(tables[2].columns[2].references?.table).toBe("addresses");
  });
});
