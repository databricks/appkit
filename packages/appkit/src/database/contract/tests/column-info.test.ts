import { describe, expect, it } from "vitest";
import {
  type ColumnInfo,
  type ColumnInfoKind,
  normalizePgType,
  pgTypeToColumnInfoKind,
} from "../index";

describe("normalizePgType", () => {
  const cases: ReadonlyArray<[input: string, expected: string]> = [
    ["text", "text"],
    ["TEXT", "text"],
    ["  Text  ", "text"],
    ["varchar(255)", "varchar"],
    ["numeric(10,2)", "numeric"],
    ["text[]", "text"],
    ["varchar(255)[]", "varchar"],
    ["timestamp with time zone", "timestamp with time zone"],
    ["TIMESTAMPTZ", "timestamptz"],
  ];

  it.each(cases)("normalizes %j -> %j", (input, expected) => {
    expect(normalizePgType(input)).toBe(expected);
  });
});

describe("pgTypeToColumnInfoKind", () => {
  const cases: ReadonlyArray<[pgType: string, kind: ColumnInfoKind]> = [
    // string
    ["text", "string"],
    ["varchar", "string"],
    ["varchar(255)", "string"],
    ["character varying", "string"],
    ["char", "string"],
    ["character", "string"],
    ["bpchar", "string"],
    ["name", "string"],
    ["citext", "string"],
    // number
    ["int2", "number"],
    ["smallint", "number"],
    ["int4", "number"],
    ["int", "number"],
    ["integer", "number"],
    ["serial", "number"],
    ["serial4", "number"],
    ["smallserial", "number"],
    ["real", "number"],
    ["float4", "number"],
    ["float8", "number"],
    ["double precision", "number"],
    ["numeric", "number"],
    ["numeric(10,2)", "number"],
    ["decimal", "number"],
    ["money", "number"],
    // bigint
    ["int8", "bigint"],
    ["bigint", "bigint"],
    ["bigserial", "bigint"],
    ["serial8", "bigint"],
    // boolean
    ["bool", "boolean"],
    ["boolean", "boolean"],
    // date
    ["timestamp", "date"],
    ["timestamptz", "date"],
    ["timestamp with time zone", "date"],
    ["timestamp without time zone", "date"],
    ["date", "date"],
    ["time", "date"],
    ["timetz", "date"],
    ["time with time zone", "date"],
    ["time without time zone", "date"],
    // json
    ["json", "json"],
    ["jsonb", "json"],
    // uuid
    ["uuid", "uuid"],
    // unknown (enums are classified upstream, not here)
    ["my_custom_enum", "unknown"],
    ["bytea", "unknown"],
    ["inet", "unknown"],
    ["", "unknown"],
  ];

  it.each(cases)("classifies %j as %j", (pgType, kind) => {
    expect(pgTypeToColumnInfoKind(pgType)).toBe(kind);
  });

  it("classifies case-insensitively and ignores parameters/array markers", () => {
    expect(pgTypeToColumnInfoKind("VARCHAR(255)")).toBe("string");
    expect(pgTypeToColumnInfoKind("TEXT[]")).toBe("string");
    expect(pgTypeToColumnInfoKind("  TimestampTZ  ")).toBe("date");
  });

  it("never classifies a custom type as enum (enum is set upstream)", () => {
    expect(pgTypeToColumnInfoKind("status_enum")).toBe("unknown");
  });
});

describe("ColumnInfo", () => {
  it("composes with a kind derived from the classifier", () => {
    const column: ColumnInfo = {
      name: "id",
      pgType: normalizePgType("INT4"),
      kind: pgTypeToColumnInfoKind("int4"),
      nullable: false,
      isPrimaryKey: true,
      isServerGenerated: true,
      isPrivate: false,
    };
    expect(column.kind).toBe("number");
    expect(column.pgType).toBe("int4");
  });

  it("carries enumValues only for enum columns", () => {
    const column: ColumnInfo = {
      name: "status",
      pgType: "status_enum",
      kind: "enum",
      nullable: false,
      isPrimaryKey: false,
      isServerGenerated: false,
      isPrivate: false,
      enumValues: ["active", "archived"],
    };
    expect(column.enumValues).toEqual(["active", "archived"]);
  });
});
