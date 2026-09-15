import { describe, expect, test } from "vitest";

import { deriveConcurrency } from "../run-evals";
import type { EvalConfig } from "../types";

describe("deriveConcurrency", () => {
  const cfg = (maxConcurrency?: number): EvalConfig => ({ maxConcurrency });

  test("--concurrency wins over any config", () => {
    const configs = new Map<string, EvalConfig>([
      ["a", cfg(2)],
      ["b", cfg(8)],
    ]);
    expect(deriveConcurrency(new Set(["a", "b"]), configs, 3)).toBe(3);
  });

  test("takes the lowest ceiling among participating agents", () => {
    const configs = new Map<string, EvalConfig>([
      ["a", cfg(1)],
      ["b", cfg(8)],
    ]);
    expect(deriveConcurrency(new Set(["a", "b"]), configs, undefined)).toBe(1);
  });

  test("ignores configs for agents not in this run", () => {
    // Agent `a`'s limit of 1 must not throttle a run that only includes `b`.
    const configs = new Map<string, EvalConfig>([
      ["a", cfg(1)],
      ["b", cfg(8)],
    ]);
    expect(deriveConcurrency(new Set(["b"]), configs, undefined)).toBe(8);
  });

  test("falls back to the default when no participating agent sets a limit", () => {
    const configs = new Map<string, EvalConfig>([["a", cfg(undefined)]]);
    expect(deriveConcurrency(new Set(["a"]), configs, undefined)).toBe(4);
  });
});
