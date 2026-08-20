import { describe, expect, expectTypeOf, it } from "vitest";

import { DEFAULT_LIMIT, MAX_LIMIT } from "../../contract";
import { defineSchema, id, text } from "../../schema-builder";
import {
  conflictTargetMeta,
  limitOrDefault,
  primaryKeyMeta,
  validateLimit,
  validateOffset,
} from "../data-path";
import {
  type DataPath,
  DataPathError,
  type IdValue,
  type QuerySpec,
  type Row,
} from "../index";

const schema = defineSchema((builder) => ({
  users: builder.table("users", {
    id: id(),
    email: text().unique(),
  }),
  events: builder.table("events", { body: text() }),
}));

describe("DataPath contract", () => {
  it("exposes the backend-neutral operations implemented in this phase", () => {
    expectTypeOf<DataPath>().toHaveProperty("select");
    expectTypeOf<DataPath>().toHaveProperty("findOne");
    expectTypeOf<DataPath>().toHaveProperty("count");
    expectTypeOf<DataPath>().toHaveProperty("insert");
    expectTypeOf<DataPath>().toHaveProperty("update");
    expectTypeOf<DataPath>().toHaveProperty("upsert");
    expectTypeOf<DataPath>().toHaveProperty("delete");
    expectTypeOf<DataPath>().toHaveProperty("raw");
    expectTypeOf<DataPath>().toHaveProperty("transaction");
  });

  it("keeps rows and identifiers backend-neutral", () => {
    expectTypeOf<Row>().toEqualTypeOf<Record<string, unknown>>();
    expectTypeOf<IdValue>().toEqualTypeOf<string | number | bigint>();
    expectTypeOf<DataPath["select"]>().returns.resolves.toEqualTypeOf<Row[]>();
    expectTypeOf<
      DataPath["findOne"]
    >().returns.resolves.toEqualTypeOf<Row | null>();
  });

  it("represents the query state translated by the Drizzle adapter", () => {
    const spec = {
      where: { email: { ilike: "%@example.com" } },
      order: { email: "asc" },
      select: ["id", "email"],
      include: {},
      limit: 10,
      offset: 5,
    } satisfies QuerySpec;
    expectTypeOf(spec).toMatchTypeOf<QuerySpec>();
  });

  it("publishes only the Phase 1 runtime values", async () => {
    expect(Object.keys(await import("../index"))).toEqual(["DataPathError"]);
  });
});

describe("runtime bounds and metadata", () => {
  it("applies the default limit and validates explicit bounds", () => {
    expect(limitOrDefault()).toBe(DEFAULT_LIMIT);
    expect(validateLimit(0)).toBe(0);
    expect(validateLimit(MAX_LIMIT)).toBe(MAX_LIMIT);
    expect(() => validateLimit(-1)).toThrow(DataPathError);
    expect(() => validateLimit(MAX_LIMIT + 1)).toThrow(DataPathError);
  });

  it("accepts only non-negative safe offsets", () => {
    expect(validateOffset(0)).toBe(0);
    expect(validateOffset(10)).toBe(10);
    expect(() => validateOffset(-1)).toThrow(DataPathError);
    expect(() => validateOffset(Number.MAX_VALUE)).toThrow(DataPathError);
  });

  it("resolves primary keys and explicit conflict targets from metadata", () => {
    expect(primaryKeyMeta(schema.$tables.users).columnName).toBe("id");
    expect(conflictTargetMeta(schema.$tables.users, "email").unique).toBe(true);
    expect(() => primaryKeyMeta(schema.$tables.events)).toThrow(DataPathError);
    expect(() => conflictTargetMeta(schema.$tables.users, "body")).toThrow(
      DataPathError,
    );
  });
});
