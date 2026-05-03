import { describe, expect, test } from "vitest";
import { mapPostgresType } from "../type-map";

describe("mapPostgresType", () => {
  test.each([
    ["text", false, "text()"],
    ["varchar", false, "varchar()"],
    ["int4", false, "integer()"],
    ["int8", false, "bigint()"],
    ["bool", false, "boolean()"],
    ["timestamp", false, "timestamp()"],
    ["timestamptz", false, "timestamp({ timezone: true })"],
    ["jsonb", false, "jsonb()"],
    ["uuid", false, "uuid()"],
  ])("maps %s to %s", (pgType, serverGenerated, expected) => {
    expect(mapPostgresType(pgType, { serverGenerated }).helper).toBe(expected);
  });

  test("uses id() for server-generated int4 primary keys", () => {
    expect(
      mapPostgresType("int4", { serverGenerated: true, isPrimaryKey: true }),
    ).toEqual({
      helper: "id()",
      isIdShortcut: true,
    });
  });

  test("uses bigid() for server-generated int8 primary keys", () => {
    expect(
      mapPostgresType("int8", { serverGenerated: true, isPrimaryKey: true }),
    ).toEqual({
      helper: "bigid()",
      isIdShortcut: true,
    });
    expect(
      mapPostgresType("bigserial", {
        serverGenerated: true,
        isPrimaryKey: true,
      }),
    ).toEqual({
      helper: "bigid()",
      isIdShortcut: true,
    });
  });

  test("does not turn non-primary generated integers into id columns", () => {
    expect(mapPostgresType("int4", { serverGenerated: true }).helper).toBe(
      "integer()",
    );
    expect(mapPostgresType("int8", { serverGenerated: true }).helper).toBe(
      "bigint()",
    );
  });

  test("keeps unknown types visible for manual cleanup", () => {
    expect(mapPostgresType("ltree").helper).toContain("TODO: pg type ltree");
  });
});
