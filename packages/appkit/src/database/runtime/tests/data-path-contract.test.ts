import { describe, expectTypeOf, it } from "vitest";
import type { DataPath, IdValue, QuerySpec, Row } from "../index";

/**
 * Type-level tests for the DataPath contract. Verified by `tsc` during
 * `pnpm typecheck`; the `it()` wrappers exist only so vitest registers the
 * file as a suite (same approach as contract/tests/registry.test.ts).
 */

describe("IdValue", () => {
  it("is a string | number union", () => {
    expectTypeOf<IdValue>().toEqualTypeOf<string | number>();
  });
});

describe("Row", () => {
  it("is an open record of unknown values", () => {
    expectTypeOf<Row>().toEqualTypeOf<Record<string, unknown>>();
  });
});

describe("QuerySpec", () => {
  it("accepts a fully-populated spec", () => {
    const spec = {
      where: { id: 1 },
      order: { name: "asc" },
      select: ["id", "name"],
      include: { posts: true },
      limit: 10,
      offset: 5,
    } satisfies QuerySpec;
    expectTypeOf(spec).toMatchTypeOf<QuerySpec>();
  });

  it("accepts an empty spec (all fields optional)", () => {
    const spec = {} satisfies QuerySpec;
    expectTypeOf(spec).toMatchTypeOf<QuerySpec>();
  });
});

describe("DataPath", () => {
  it("exposes the full data-access surface", () => {
    expectTypeOf<DataPath>().toHaveProperty("select");
    expectTypeOf<DataPath>().toHaveProperty("findOne");
    expectTypeOf<DataPath>().toHaveProperty("count");
    expectTypeOf<DataPath>().toHaveProperty("insert");
    expectTypeOf<DataPath>().toHaveProperty("update");
    expectTypeOf<DataPath>().toHaveProperty("upsert");
    expectTypeOf<DataPath>().toHaveProperty("delete");
    expectTypeOf<DataPath>().toHaveProperty("getColumn");
    expectTypeOf<DataPath>().toHaveProperty("raw");
    expectTypeOf<DataPath>().toHaveProperty("transaction");
  });

  it("resolves rows from select and a nullable row from findOne", () => {
    expectTypeOf<DataPath["select"]>().returns.resolves.toEqualTypeOf<Row[]>();
    expectTypeOf<
      DataPath["findOne"]
    >().returns.resolves.toEqualTypeOf<Row | null>();
    expectTypeOf<DataPath["count"]>().returns.resolves.toEqualTypeOf<number>();
  });
});
