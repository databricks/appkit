import { describe, expect, test } from "vitest";
import { applyToolkitOptions } from "../toolkit-options";

describe("applyToolkitOptions", () => {
  test("default prefix is `${pluginName}.`", () => {
    expect(applyToolkitOptions("query", "analytics")).toBe("analytics.query");
  });

  test("empty `prefix` drops the namespace", () => {
    expect(applyToolkitOptions("query", "analytics", { prefix: "" })).toBe(
      "query",
    );
  });

  test("explicit prefix overrides the default", () => {
    expect(applyToolkitOptions("query", "analytics", { prefix: "sql_" })).toBe(
      "sql_query",
    );
  });

  test("`only` allowlist filters out unmatched names", () => {
    expect(
      applyToolkitOptions("destructive", "analytics", { only: ["query"] }),
    ).toBeNull();
    expect(applyToolkitOptions("query", "analytics", { only: ["query"] })).toBe(
      "analytics.query",
    );
  });

  test("`except` denylist drops matched names", () => {
    expect(
      applyToolkitOptions("query", "analytics", { except: ["query"] }),
    ).toBeNull();
  });

  test("`rename` wins over the prefix path", () => {
    expect(
      applyToolkitOptions("query", "analytics", {
        rename: { query: "sql_query" },
      }),
    ).toBe("sql_query");
  });

  test("`rename: { name: undefined }` falls through to the prefix path", () => {
    // Regression: prior implementation used `Object.hasOwn(rename, name) ?
    // rename[name] : ...` which returned `undefined` when the key was
    // present-but-undefined (e.g. from a ternary that didn't fire). That
    // produced a tool keyed literally `"undefined"` downstream.
    expect(
      applyToolkitOptions("query", "analytics", {
        rename: { query: undefined as unknown as string },
      }),
    ).toBe("analytics.query");
  });

  test("`rename: { name: '' }` falls through (empty string is not a valid key)", () => {
    expect(
      applyToolkitOptions("query", "analytics", {
        rename: { query: "" },
      }),
    ).toBe("analytics.query");
  });
});
