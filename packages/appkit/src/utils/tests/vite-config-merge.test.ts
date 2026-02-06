import type { Plugin } from "vite";
import { describe, expect, test } from "vitest";
import { mergeConfigDedup } from "../vite-config-merge";

const plugin = (name: string): Plugin => ({ name, enforce: "pre" });

const simpleMerge = (a: Plugin, b: Plugin) => ({ ...a, ...b });

describe("mergeConfigDedup", () => {
  test("deduplicates plugins by name, keeping the first occurrence", () => {
    const base = { plugins: [plugin("a"), plugin("b")] };
    const override = { plugins: [plugin("b"), plugin("c")] };

    const result = mergeConfigDedup(base, override, simpleMerge);

    expect(result.plugins.map((p: Plugin) => p.name)).toEqual(["a", "b", "c"]);
  });

  test("returns merged config when no plugins on either side", () => {
    const result = mergeConfigDedup({ x: 1 }, { y: 2 }, simpleMerge);
    expect(result).toEqual({ x: 1, y: 2 });
    expect(result.plugins).toBeUndefined();
  });

  test("preserves plugins when only base has them", () => {
    const base = { plugins: [plugin("a")] };
    const override = { other: true };

    const result = mergeConfigDedup(base, override, simpleMerge);
    // mergeFn merges everything; dedup branch only runs when both have plugins
    expect(result.plugins).toBeDefined();
  });

  test("flattens array-returning plugins (e.g. @tailwindcss/vite)", () => {
    const tailwindPreset = [
      plugin("tw:base"),
      plugin("tw:scan"),
      plugin("tw:generate"),
    ];
    const base = { plugins: [tailwindPreset] };
    const override = { plugins: [plugin("react")] };

    const result = mergeConfigDedup(base, override, simpleMerge);

    expect(result.plugins.map((p: Plugin) => p.name)).toEqual([
      "tw:base",
      "tw:scan",
      "tw:generate",
      "react",
    ]);
  });

  test("deduplicates across flattened array plugins and single plugins", () => {
    const preset = [plugin("shared"), plugin("unique-a")];
    const base = { plugins: [preset] };
    const override = { plugins: [plugin("shared"), plugin("unique-b")] };

    const result = mergeConfigDedup(base, override, simpleMerge);

    expect(result.plugins.map((p: Plugin) => p.name)).toEqual([
      "shared",
      "unique-a",
      "unique-b",
    ]);
  });

  test("handles deeply nested plugin arrays", () => {
    const deep = [[plugin("deep-a")], [[plugin("deep-b")]]];
    const base = { plugins: [deep] };
    const override = { plugins: [plugin("top")] };

    const result = mergeConfigDedup(base, override, simpleMerge);

    expect(result.plugins.map((p: Plugin) => p.name)).toEqual([
      "deep-a",
      "deep-b",
      "top",
    ]);
  });

  test("filters out false/null/undefined plugin entries", () => {
    const base = { plugins: [plugin("a"), false, null] };
    const override = { plugins: [undefined, plugin("b")] };

    const result = mergeConfigDedup(base, override, simpleMerge);

    expect(result.plugins.map((p: Plugin) => p.name)).toEqual(["a", "b"]);
  });

  test("handles mixed falsy and array plugins", () => {
    const preset = [plugin("tw:base"), plugin("tw:scan")];
    const base = { plugins: [false, preset, null] };
    const override = { plugins: [undefined, plugin("react"), false] };

    const result = mergeConfigDedup(base, override, simpleMerge);

    expect(result.plugins.map((p: Plugin) => p.name)).toEqual([
      "tw:base",
      "tw:scan",
      "react",
    ]);
  });
});
