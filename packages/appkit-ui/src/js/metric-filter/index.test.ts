import type {
  MetricFilter as SharedMetricFilter,
  MetricFilterOperatorName as SharedMetricFilterOperatorName,
  MetricOrderBy as SharedMetricOrderBy,
  MetricOrderDirection as SharedMetricOrderDirection,
  MetricPredicate as SharedMetricPredicate,
} from "shared";
import { describe, expect, expectTypeOf, test } from "vitest";
import {
  type MetricFilter,
  type MetricFilterOperatorName,
  type MetricOrderBy,
  type MetricOrderDirection,
  type MetricPredicate,
  toMetricFilter,
} from "./index";

describe("toMetricFilter", () => {
  test("re-exports the shared metric-filter AST types", () => {
    expectTypeOf<MetricFilter>().toEqualTypeOf<SharedMetricFilter>();
    expectTypeOf<MetricFilterOperatorName>().toEqualTypeOf<SharedMetricFilterOperatorName>();
    expectTypeOf<MetricOrderBy>().toEqualTypeOf<SharedMetricOrderBy>();
    expectTypeOf<MetricOrderDirection>().toEqualTypeOf<SharedMetricOrderDirection>();
    expectTypeOf<MetricPredicate>().toEqualTypeOf<SharedMetricPredicate>();
  });

  test("returns undefined for an empty selection", () => {
    expect(toMetricFilter({})).toBeUndefined();
  });

  test("omits members with undefined values", () => {
    expect(toMetricFilter({ region: undefined })).toBeUndefined();
    expect(toMetricFilter({ region: undefined, segment: "SMB" })).toEqual({
      member: "segment",
      operator: "equals",
      values: ["SMB"],
    });
  });

  test("omits members with empty-array values", () => {
    expect(toMetricFilter({ region: [] })).toBeUndefined();
  });

  test("compiles a null value to notSet (IS NULL), not equals 'null'", () => {
    expect(toMetricFilter({ region: null })).toEqual({
      member: "region",
      operator: "notSet",
    });
  });

  test("distinguishes null (IS NULL) from undefined (no filter)", () => {
    expect(toMetricFilter({ region: null, segment: undefined })).toEqual({
      member: "region",
      operator: "notSet",
    });
  });

  test("omits `values` entirely for a null member", () => {
    // `notSet` rejects `values` server-side, so the key must be absent rather
    // than present-and-empty.
    expect(toMetricFilter({ region: null })).not.toHaveProperty("values");
  });

  test("combines a null member with a scalar member under and", () => {
    expect(toMetricFilter({ region: null, segment: "SMB" })).toEqual({
      and: [
        { member: "region", operator: "notSet" },
        { member: "segment", operator: "equals", values: ["SMB"] },
      ],
    });
  });

  test("compiles a single scalar member to a bare equals predicate", () => {
    expect(toMetricFilter({ region: "EMEA" })).toEqual({
      member: "region",
      operator: "equals",
      values: ["EMEA"],
    });
  });

  test("compiles a numeric scalar to an equals predicate", () => {
    expect(toMetricFilter({ tier: 2 })).toEqual({
      member: "tier",
      operator: "equals",
      values: [2],
    });
  });

  test("compiles an array member to an in predicate", () => {
    expect(toMetricFilter({ region: ["EMEA", "APAC"] })).toEqual({
      member: "region",
      operator: "in",
      values: ["EMEA", "APAC"],
    });
  });

  test("AND-groups multiple members, mixing equals and in", () => {
    expect(
      toMetricFilter({ region: ["EMEA", "APAC"], segment: "SMB" }),
    ).toEqual({
      and: [
        { member: "region", operator: "in", values: ["EMEA", "APAC"] },
        { member: "segment", operator: "equals", values: ["SMB"] },
      ],
    });
  });

  test("copies array values rather than aliasing the caller's array", () => {
    const values = ["EMEA", "APAC"];
    const filter = toMetricFilter({ region: values });
    // A single member compiles to a bare predicate (has `values`), not a group.
    if (!filter || !("values" in filter)) {
      throw new Error("expected a leaf predicate with values");
    }
    expect(filter.values).toEqual(values);
    expect(filter.values).not.toBe(values);
  });

  test("produces a MetricFilter assignable to the exported type", () => {
    const filter: MetricFilter | undefined = toMetricFilter({ region: "EMEA" });
    expect(filter).toBeDefined();
  });
});
