import { describe, expect, it } from "vitest";
import { DEFAULT_LIMIT, MAX_LIMIT } from "../../contract";
import { defineSchema, id, text } from "../../schema-builder";
import {
  clampLimit,
  DataPathError,
  isRelationPredicate,
  limitOrDefault,
  primaryKeyMeta,
} from "../data-path";

const schema = defineSchema((t) => {
  const users = t.table("users", { id: id(), name: text() });
  const notes = t.table("notes", { body: text() });
  return { users, notes };
});

describe("primaryKeyMeta", () => {
  it("returns the primary key meta", () => {
    expect(primaryKeyMeta(schema.$tables.users).columnName).toBe("id");
  });

  it("throws (500) when the table has no primary key", () => {
    try {
      primaryKeyMeta(schema.$tables.notes);
      throw new Error("expected primaryKeyMeta to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DataPathError);
      expect((err as DataPathError).statusCode).toBe(500);
    }
  });
});

describe("isRelationPredicate", () => {
  it("is true for { some } / { none }", () => {
    expect(isRelationPredicate({ some: {} })).toBe(true);
    expect(isRelationPredicate({ none: {} })).toBe(true);
  });

  it("is false for operator objects, arrays, scalars and null", () => {
    expect(isRelationPredicate({ eq: 1 })).toBe(false);
    expect(isRelationPredicate([1, 2])).toBe(false);
    expect(isRelationPredicate("x")).toBe(false);
    expect(isRelationPredicate(null)).toBe(false);
  });
});

describe("DataPathError", () => {
  it("defaults to status 400", () => {
    const err = new DataPathError("bad");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DataPathError");
    expect(err.statusCode).toBe(400);
  });

  it("accepts a custom status code", () => {
    expect(new DataPathError("boom", 500).statusCode).toBe(500);
  });
});

describe("limit helpers", () => {
  it("uses DEFAULT_LIMIT when no limit is supplied", () => {
    expect(limitOrDefault()).toBe(DEFAULT_LIMIT);
  });

  it("caps limits at MAX_LIMIT", () => {
    expect(clampLimit(MAX_LIMIT + 1)).toBe(MAX_LIMIT);
  });

  it("rejects negative or fractional limits", () => {
    expect(() => clampLimit(-1)).toThrow(/non-negative integer/);
    expect(() => clampLimit(1.5)).toThrow(/non-negative integer/);
  });
});
