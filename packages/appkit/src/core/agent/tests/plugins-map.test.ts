import { describe, expect, test } from "vitest";

import { createPluginsProxy } from "../plugins-map";
import type { PluginToolkitProvider } from "../types";

describe("createPluginsProxy — miss messages", () => {
  const entries: Record<string, PluginToolkitProvider> = {
    analytics: { toolkit: () => ({}) },
  };

  test("a registered non-provider plugin reports it is not a ToolProvider", () => {
    const proxy = createPluginsProxy(entries, "test", new Set(["aiSearch"]));
    expect(() => (proxy as Record<string, unknown>).aiSearch).toThrow(
      /registered but exposes no agent tools/,
    );
  });

  test("an unknown plugin still reports 'not registered'", () => {
    const proxy = createPluginsProxy(entries, "test", new Set(["aiSearch"]));
    expect(() => (proxy as Record<string, unknown>).ghost).toThrow(
      /not registered/,
    );
  });

  test("a known tool-providing plugin resolves to its entry", () => {
    const proxy = createPluginsProxy(entries, "test");
    expect((proxy as Record<string, unknown>).analytics).toBe(
      entries.analytics,
    );
  });
});
