import { describe, expect, expectTypeOf, it } from "vitest";

import { DEFAULT_LIMIT, MAX_LIMIT, MAX_OFFSET } from "../../contract";
import { DatabasePluginError } from "../../errors";
import { defineSchema, id, text } from "../../schema-builder";
import {
  conflictTargetMeta,
  limitOrDefault,
  primaryKeyMeta,
  validateLimit,
  validateOffset,
} from "../data-path";
import type { DataPath, IdValue, QuerySpec, Row } from "../index";

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

  it("keeps the runtime barrel type-only", async () => {
    expect(Object.keys(await import("../index"))).toEqual([]);
  });
});

describe("runtime bounds and metadata", () => {
  it("applies the default limit and validates explicit bounds", () => {
    expect(limitOrDefault()).toBe(DEFAULT_LIMIT);
    expect(validateLimit(0)).toBe(0);
    expect(validateLimit(MAX_LIMIT)).toBe(MAX_LIMIT);
    expect(() => validateLimit(-1)).toThrow(DatabasePluginError);
    expect(() => validateLimit(MAX_LIMIT + 1)).toThrow(DatabasePluginError);
  });

  it("accepts only non-negative offsets within MAX_OFFSET", () => {
    expect(validateOffset(0)).toBe(0);
    expect(validateOffset(10)).toBe(10);
    expect(validateOffset(MAX_OFFSET)).toBe(MAX_OFFSET);
    expect(() => validateOffset(-1)).toThrow(DatabasePluginError);
    expect(() => validateOffset(1.5)).toThrow(DatabasePluginError);
    expect(() => validateOffset(MAX_OFFSET + 1)).toThrow(DatabasePluginError);
    expect(() => validateOffset(Number.MAX_VALUE)).toThrow(DatabasePluginError);
  });

  it("resolves primary keys and explicit conflict targets from metadata", () => {
    expect(primaryKeyMeta(schema.$tables.users).columnName).toBe("id");
    expect(conflictTargetMeta(schema.$tables.users, "email").unique).toBe(true);
    expect(() => primaryKeyMeta(schema.$tables.events)).toThrow(
      DatabasePluginError,
    );
    expect(() => conflictTargetMeta(schema.$tables.users, "body")).toThrow(
      DatabasePluginError,
    );
  });
});
