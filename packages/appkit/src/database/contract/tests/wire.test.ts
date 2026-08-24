import { describe, expect, it } from "vitest";

import {
  DEFAULT_LIMIT,
  FILTER_OPERATORS,
  type FilterOperator,
  IN_CAP,
  isFilterOperator,
  MAX_INCLUDES,
  MAX_LIMIT,
  MAX_OFFSET,
  MAX_WHERE_CONDITIONS,
  MAX_WHERE_DEPTH,
  MAX_WHERE_GROUP_ITEMS,
} from "../index";

describe("wire caps", () => {
  it("pins the literal cap values", () => {
    expect(IN_CAP).toBe(100);
    expect(MAX_LIMIT).toBe(500);
    expect(MAX_OFFSET).toBe(10_000);
    expect(DEFAULT_LIMIT).toBe(50);
    expect(MAX_INCLUDES).toBe(10);
    expect(MAX_WHERE_DEPTH).toBe(5);
    expect(MAX_WHERE_GROUP_ITEMS).toBe(20);
    expect(MAX_WHERE_CONDITIONS).toBe(50);
  });

  it("keeps DEFAULT_LIMIT within MAX_LIMIT", () => {
    expect(DEFAULT_LIMIT).toBeLessThanOrEqual(MAX_LIMIT);
  });

  it("keeps MAX_LIMIT within MAX_OFFSET", () => {
    expect(MAX_LIMIT).toBeLessThanOrEqual(MAX_OFFSET);
  });

  it("pins the filter-operator set (snapshot of the supported operators)", () => {
    expect(FILTER_OPERATORS).toEqual([
      "eq",
      "neq",
      "gt",
      "gte",
      "lt",
      "lte",
      "like",
      "ilike",
      "in",
      "is",
    ]);
  });
});

describe("isFilterOperator", () => {
  it.each([...FILTER_OPERATORS])("accepts %j", (op) => {
    expect(isFilterOperator(op)).toBe(true);
  });

  it.each(["", "EQ", "equals", "between", "not", "or", "and", "=="])(
    "rejects %j",
    (token) => {
      expect(isFilterOperator(token)).toBe(false);
    },
  );

  it("narrows an unknown string to FilterOperator", () => {
    const token: string = "ilike";
    if (isFilterOperator(token)) {
      const op: FilterOperator = token;
      expect(FILTER_OPERATORS).toContain(op);
    } else {
      throw new Error("expected a valid operator");
    }
  });
});
