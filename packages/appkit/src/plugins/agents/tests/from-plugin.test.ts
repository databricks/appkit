import { describe, expect, test } from "vitest";
import {
  FROM_PLUGIN_MARKER,
  fromPlugin,
  isFromPluginMarker,
} from "../../../core/agent/from-plugin";

function fakeFactory(name: string) {
  const f = () => ({ name });
  Object.defineProperty(f, "pluginName", { value: name, enumerable: true });
  return f as typeof f & { readonly pluginName: string };
}

describe("fromPlugin", () => {
  test("returns a spread-friendly object with a single symbol-keyed marker", () => {
    const spread = fromPlugin(fakeFactory("analytics"));

    expect(Object.keys(spread)).toHaveLength(0);
    const syms = Object.getOwnPropertySymbols(spread);
    expect(syms).toHaveLength(1);

    const marker = (spread as Record<symbol, unknown>)[syms[0]!];
    expect(isFromPluginMarker(marker)).toBe(true);
    expect((marker as { pluginName: string }).pluginName).toBe("analytics");
  });

  test("multiple calls produce distinct symbol keys (spreads coexist)", () => {
    const spread = {
      ...fromPlugin(fakeFactory("analytics")),
      ...fromPlugin(fakeFactory("analytics")),
      ...fromPlugin(fakeFactory("files")),
    };

    const syms = Object.getOwnPropertySymbols(spread);
    expect(syms).toHaveLength(3);
  });

  test("passes opts through to the marker", () => {
    const spread = fromPlugin(fakeFactory("analytics"), {
      only: ["query"],
      prefix: "q_",
    });
    const sym = Object.getOwnPropertySymbols(spread)[0]!;
    const marker = (spread as Record<symbol, unknown>)[sym] as {
      opts: { only: string[]; prefix: string };
    };
    expect(marker.opts.only).toEqual(["query"]);
    expect(marker.opts.prefix).toBe("q_");
  });

  test("throws when factory has no pluginName", () => {
    const missing = () => ({ name: "nope" });
    expect(() =>
      fromPlugin(missing as unknown as { readonly pluginName: string }),
    ).toThrow(/missing pluginName/);
  });

  test("FROM_PLUGIN_MARKER is a globally-interned symbol", () => {
    expect(FROM_PLUGIN_MARKER).toBe(
      Symbol.for("@databricks/appkit.fromPluginMarker"),
    );
  });
});

describe("isFromPluginMarker", () => {
  test("returns true for real markers", () => {
    const spread = fromPlugin(fakeFactory("analytics"));
    const sym = Object.getOwnPropertySymbols(spread)[0]!;
    expect(isFromPluginMarker((spread as Record<symbol, unknown>)[sym])).toBe(
      true,
    );
  });

  test("returns false for objects without the brand", () => {
    expect(isFromPluginMarker({ pluginName: "x" })).toBe(false);
    expect(isFromPluginMarker(null)).toBe(false);
    expect(isFromPluginMarker(undefined)).toBe(false);
    expect(isFromPluginMarker("string")).toBe(false);
  });
});
