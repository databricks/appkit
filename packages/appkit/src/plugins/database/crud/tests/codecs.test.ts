import { describe, expect, it } from "vitest";
import { DatabasePluginError } from "../../../../database/errors";
import {
  bigint,
  boolean,
  defineSchema,
  enumColumn,
  id,
  integer,
  jsonb,
  text,
  timestamp,
  uuid,
  varchar,
} from "../../../../database/schema-builder";
import { compileColumn } from "../codecs";

const schema = defineSchema((builder) => {
  const things = builder.table("things", {
    id: id(),
    name: text(),
    label: varchar(4),
    count: integer(),
    total: bigint(),
    active: boolean(),
    external: uuid(),
    status: enumColumn("codec_status", ["active", "disabled"]),
    createdAt: timestamp(),
    payload: jsonb(),
  });
  return { things };
});

const columns = schema.$tables.things.$columns;
const column = (name: keyof typeof columns) => compileColumn(columns[name]);
const UUID = "123e4567-e89b-12d3-a456-426614174000";

describe("compileColumn decode", () => {
  it("accepts the canonical wire form of every supported kind", () => {
    expect(column("count").decode(7)).toBe(7);
    expect(column("count").decode("7")).toBe(7);
    expect(column("total").decode("9007199254740993")).toBe(9007199254740993n);
    expect(column("total").decode(12)).toBe(12n);
    expect(column("active").decode(true)).toBe(true);
    expect(column("name").decode("Ada")).toBe("Ada");
    expect(column("external").decode(UUID)).toBe(UUID);
    expect(column("status").decode("active")).toBe("active");
    expect(column("createdAt").decode("2020-01-01T00:00:00Z")).toBe(
      "2020-01-01T00:00:00Z",
    );
  });

  it("rejects coercible input instead of guessing the intended value", () => {
    expect(column("active").decode("true")).toBeUndefined();
    expect(column("count").decode("7.0")).toBeUndefined();
    expect(column("count").decode("007")).toBeUndefined();
    expect(column("count").decode(7.5)).toBeUndefined();
    expect(column("count").decode(2_147_483_648)).toBeUndefined();
    expect(column("total").decode("1e3")).toBeUndefined();
    expect(column("total").decode(1.5)).toBeUndefined();
    expect(column("name").decode(7)).toBeUndefined();
    expect(column("label").decode("toolong")).toBeUndefined();
    expect(column("external").decode("not-a-uuid")).toBeUndefined();
    expect(column("status").decode("unknown")).toBeUndefined();
    expect(column("createdAt").decode("yesterday")).toBeUndefined();
    expect(column("createdAt").decode(0)).toBeUndefined();
  });

  it("keeps unfilterable kinds undecodable", () => {
    expect(column("payload").decode({ any: "value" })).toBeUndefined();
    expect(column("name").decode(null)).toBeUndefined();
    expect(column("name").decode(undefined)).toBeUndefined();
  });
});

describe("compileColumn encode", () => {
  it("emits one deterministic JSON form per kind", () => {
    expect(column("total").encode(9007199254740993n)).toBe("9007199254740993");
    expect(column("total").encode(12)).toBe("12");
    expect(column("count").encode(7)).toBe(7);
    expect(column("active").encode(false)).toBe(false);
    expect(column("createdAt").encode("2020-01-01T00:00:00Z")).toBe(
      "2020-01-01T00:00:00Z",
    );
    expect(column("payload").encode({ nested: [1, "two"] })).toEqual({
      nested: [1, "two"],
    });
    expect(column("name").encode(null)).toBeNull();
    expect(column("name").encode(undefined)).toBeNull();
  });

  it("fails closed when a driver value contradicts its column", () => {
    expect(() => column("name").encode(7)).toThrow(DatabasePluginError);
    expect(() => column("createdAt").encode(new Date())).toThrow(
      DatabasePluginError,
    );
    expect(() => column("count").encode(Number.NaN)).toThrow(
      DatabasePluginError,
    );
    expect(() => column("payload").encode(new Map())).toThrow(
      DatabasePluginError,
    );
    expect(() => column("name").encode(7)).toThrow(
      expect.objectContaining({ category: "INTERNAL" }),
    );
  });
});
