import { describe, expect, test } from "vitest";
import { resolveEvalDefault } from "../run-evals";

const def = { description: "x", test: async () => {} };

describe("resolveEvalDefault (module interop)", () => {
  test("pure ESM: mod.default", () => {
    expect(resolveEvalDefault({ default: def })).toBe(def);
  });

  test("CJS __esModule double-wrap: mod.default.default", () => {
    expect(
      resolveEvalDefault({ default: { __esModule: true, default: def } }),
    ).toBe(def);
  });

  test("direct: mod is the def", () => {
    expect(resolveEvalDefault(def)).toBe(def);
  });

  test("no default export → undefined", () => {
    expect(resolveEvalDefault({ default: { notTest: 1 } })).toBeUndefined();
    expect(resolveEvalDefault(null)).toBeUndefined();
  });
});
