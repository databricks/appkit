import { describe, expect, test } from "vitest";

import {
  matchesTags,
  resolveConfigDefault,
  resolveEvalDefault,
} from "../run-evals";

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

const config = { maxConcurrency: 4, timeoutMs: 1000 };

describe("resolveConfigDefault (module interop)", () => {
  test("pure ESM: mod.default", () => {
    expect(resolveConfigDefault({ default: config })).toBe(config);
  });

  test("CJS __esModule double-wrap: mod.default.default", () => {
    expect(
      resolveConfigDefault({ default: { __esModule: true, default: config } }),
    ).toBe(config);
  });

  test("no default export → undefined", () => {
    expect(resolveConfigDefault(null)).toBeUndefined();
    expect(resolveConfigDefault(undefined)).toBeUndefined();
  });
});

describe("matchesTags", () => {
  test("no filter runs everything", () => {
    expect(matchesTags(["a"], undefined)).toBe(true);
    expect(matchesTags(undefined, [])).toBe(true);
    expect(matchesTags(undefined, undefined)).toBe(true);
  });

  test("matches when tags intersect the filter", () => {
    expect(matchesTags(["smoke", "slow"], ["smoke"])).toBe(true);
  });

  test("excludes when tags don't intersect or the def has none", () => {
    expect(matchesTags(["slow"], ["smoke"])).toBe(false);
    expect(matchesTags(undefined, ["smoke"])).toBe(false);
    expect(matchesTags([], ["smoke"])).toBe(false);
  });
});
