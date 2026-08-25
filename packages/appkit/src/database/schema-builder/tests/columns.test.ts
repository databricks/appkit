import { describe, expect, expectTypeOf, it } from "vitest";

import {
  bigid,
  bigint,
  boolean,
  ColumnBuilder,
  enumColumn,
  fk,
  id,
  integer,
  jsonb,
  SchemaBuildError,
  text,
  timestamp,
  uuid,
  varchar,
} from "../index";
import type { ColumnValueKind } from "../types";

describe("column constructors", () => {
  it("uses value kinds independently of storage declarations", () => {
    expectTypeOf<ColumnValueKind>().toEqualTypeOf<
      | "string"
      | "number"
      | "bigint"
      | "boolean"
      | "date"
      | "json"
      | "uuid"
      | "enum"
      | "unknown"
    >();
  });

  it.each([
    ["id", id(), { storageKind: "id", kind: "number" }],
    ["bigid", bigid(), { storageKind: "bigid", kind: "bigint" }],
    ["text", text(), { storageKind: "text", kind: "string" }],
    ["integer", integer(), { storageKind: "integer", kind: "number" }],
    ["bigint", bigint(), { storageKind: "bigint", kind: "bigint" }],
    ["boolean", boolean(), { storageKind: "boolean", kind: "boolean" }],
    ["uuid", uuid(), { storageKind: "uuid", kind: "uuid" }],
    ["jsonb", jsonb(), { storageKind: "jsonb", kind: "json" }],
  ])("builds %s metadata", (_label, builder, expected) => {
    expect(builder).toBeInstanceOf(ColumnBuilder);
    expect(builder._meta).toMatchObject(expected);
  });

  it("validates varchar lengths", () => {
    expect(varchar()._meta.varcharLength).toBe(255);
    expect(varchar(64)._meta.varcharLength).toBe(64);
    expect(() => varchar(0)).toThrow(SchemaBuildError);
    expect(() => varchar(1.5)).toThrow(/length must be an integer/);
  });

  it("records timestamp options", () => {
    expect(timestamp()._meta.withTimezone).toBe(false);
    expect(timestamp({ withTimezone: true })._meta.withTimezone).toBe(true);
  });
});

describe("identity and modifiers", () => {
  it.each([id(), bigid()])(
    "makes generated identities real not-null PK metadata",
    (builder) => {
      expect(builder._meta).toMatchObject({
        serverGenerated: true,
        primaryKey: true,
        notNull: true,
        hasDefault: true,
      });
    },
  );

  it("keeps the supported modifier chain and removes owner", () => {
    const builder = text().notNull().unique().primaryKey().private();
    expect(builder._meta).toMatchObject({
      notNull: true,
      unique: true,
      primaryKey: true,
      isPrivate: true,
    });
    expect("owner" in builder).toBe(false);
    // @ts-expect-error DatabasePlugin owner/RLS metadata is not supported.
    expectTypeOf<ReturnType<typeof text>["owner"]>().toBeFunction();
  });
});

describe("default helpers", () => {
  it("records literal defaults without synthesizing them", () => {
    expect(text().default("O'Brien")._meta).toMatchObject({
      hasDefault: true,
      defaultValue: "O'Brien",
    });
    expect(integer().default(42)._meta.defaultValue).toBe(42);
    expect(boolean().default(false)._meta.defaultValue).toBe(false);
  });

  it("restricts helpers to timestamp and UUID columns", () => {
    expect(timestamp().defaultNow()._meta.defaultNow).toBe(true);
    expect(uuid().defaultRandom()._meta.defaultRandom).toBe(true);
    expect(() => text().defaultNow()).toThrow(/timestamp/);
    expect(() => text().defaultRandom()).toThrow(/uuid/);
  });

  it("allows only one explicit default mode", () => {
    expect(() => text().default("x").default("y")).toThrow(/only one default/);
    expect(() =>
      timestamp().defaultNow().default("2020-01-01T00:00:00Z"),
    ).toThrow(/only one default/);
    expect(() => id().default(1)).toThrow(/only one default/);
  });
});

describe("foreign-key modifiers", () => {
  const ref = {
    __isColumnRef: true as const,
    tableName: "users",
    columnName: "id",
  };

  it("accepts referential actions only on fk columns", () => {
    const builder = fk(ref).onDelete("cascade").onUpdate("set null");
    expect(builder._meta.onDelete).toBe("cascade");
    expect(builder._meta.onUpdate).toBe("set null");
    expect(() => integer().onDelete("cascade")).toThrow(/only valid on fk/);
    expect(() => fk(ref).onDelete("truncate" as never)).toThrow(
      /Unsupported referential action/,
    );
  });

  it("pins the supported referential-action type", () => {
    expectTypeOf<Parameters<ColumnBuilder["onDelete"]>[0]>().toEqualTypeOf<
      "cascade" | "set null" | "set default" | "restrict" | "no action"
    >();
  });
});

describe("enumColumn", () => {
  it("clones and validates enum declarations", () => {
    const values = ["active", "archived"];
    const builder = enumColumn("status", values);
    values.push("mutated");
    expect(builder._meta.enumValues).toEqual(["active", "archived"]);
    expect(Object.isFrozen(builder._meta.enumValues)).toBe(true);
  });

  it("rejects empty and duplicate declarations", () => {
    expect(() => enumColumn("status", [])).toThrow(/at least one value/);
    expect(() => enumColumn("status", ["active", "active"])).toThrow(
      /duplicate values/,
    );
  });
});
