import { describe, expect, test } from "vitest";
import type { ColumnInfo } from "@/js";
import {
  coerceFormValues,
  filterCreateColumns,
  filterEditColumns,
  getDefaultValues,
  toPatchPayload,
} from "../entity-form";

const columns: ColumnInfo[] = [
  {
    name: "id",
    type: "number",
    nullable: false,
    primaryKey: true,
    hasDefault: true,
    generated: true,
  },
  {
    name: "email",
    type: "string",
    nullable: false,
    primaryKey: false,
    hasDefault: false,
    generated: false,
  },
  {
    name: "nickname",
    type: "string",
    nullable: true,
    primaryKey: false,
    hasDefault: false,
    generated: false,
  },
  {
    name: "is_admin",
    type: "boolean",
    nullable: false,
    primaryKey: false,
    hasDefault: true,
    generated: false,
  },
  {
    name: "score",
    type: "number",
    nullable: true,
    primaryKey: false,
    hasDefault: false,
    generated: false,
  },
  {
    name: "tags",
    type: "json",
    nullable: true,
    primaryKey: false,
    hasDefault: false,
    generated: false,
  },
  {
    name: "created_at",
    type: "date",
    nullable: false,
    primaryKey: false,
    hasDefault: true,
    generated: true,
  },
];

describe("filterCreateColumns", () => {
  test("hides generated columns by default", () => {
    const out = filterCreateColumns(columns).map((c) => c.name);
    expect(out).toEqual(["email", "nickname", "is_admin", "score", "tags"]);
  });

  test("respects an explicit `fields` allowlist (still drops generated)", () => {
    const out = filterCreateColumns(columns, ["email", "id", "score"]).map(
      (c) => c.name,
    );
    expect(out).toEqual(["email", "score"]);
  });
});

describe("filterEditColumns", () => {
  test("hides generated AND primary-key columns by default", () => {
    const out = filterEditColumns(columns).map((c) => c.name);
    expect(out).toEqual(["email", "nickname", "is_admin", "score", "tags"]);
  });
});

describe("getDefaultValues", () => {
  test("fills nullable columns with null and required text with empty string", () => {
    const defaults = getDefaultValues(columns);
    expect(defaults).toEqual({
      id: "",
      email: "",
      nickname: null,
      is_admin: false,
      score: null,
      tags: null,
      created_at: "",
    });
  });

  test("merges base values without overwriting them", () => {
    const defaults = getDefaultValues(columns, {
      email: "alice@x",
      score: 42,
    });
    expect(defaults.email).toBe("alice@x");
    expect(defaults.score).toBe(42);
    // Untouched columns still get their type-appropriate default.
    expect(defaults.is_admin).toBe(false);
    expect(defaults.nickname).toBeNull();
  });
});

describe("coerceFormValues", () => {
  test("parses JSON fields from textarea strings", () => {
    const out = coerceFormValues(columns, { tags: '{"a":1}' });
    expect(out.tags).toEqual({ a: 1 });
  });

  test("converts empty JSON textarea to null", () => {
    const out = coerceFormValues(columns, { tags: "  " });
    expect(out.tags).toBeNull();
  });

  test("throws on invalid JSON with the column name in the message", () => {
    expect(() => coerceFormValues(columns, { tags: "not-json" })).toThrowError(
      /Invalid JSON for tags/,
    );
  });

  test("coerces empty number to null", () => {
    const out = coerceFormValues(columns, { score: "" });
    expect(out.score).toBeNull();
  });

  test("nullable empty string becomes null; required empty string stays empty", () => {
    const out = coerceFormValues(columns, { nickname: "", email: "" });
    expect(out.nickname).toBeNull();
    expect(out.email).toBe("");
  });

  test("ignores keys that are not declared columns", () => {
    const out = coerceFormValues(columns, { unknown: "x" });
    expect("unknown" in out).toBe(false);
  });
});

describe("toPatchPayload", () => {
  test("only includes columns flagged dirty by react-hook-form", () => {
    const coerced = { email: "a@x", nickname: "Al", score: 7 };
    const patch = toPatchPayload(
      coerced,
      { email: true, nickname: false },
      columns,
    );
    expect(patch).toEqual({ email: "a@x" });
  });

  test("non-dirty fields are not echoed back even if present in coerced", () => {
    const patch = toPatchPayload({ score: 7 }, {}, columns);
    expect(patch).toEqual({});
  });
});
