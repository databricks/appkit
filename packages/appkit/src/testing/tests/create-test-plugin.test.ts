import type { BasePluginConfig, PluginManifest } from "shared";
import { describe, expect, test } from "vitest";

import { Plugin, toPlugin } from "../../plugin";
import { createTestPlugin } from "../create-test-plugin";

/**
 * The behaviour that matters is the merge: an instance built by hand skips
 * DEFAULT_CONFIG and forgets `name`, so a test against it can pass wrongly.
 */

interface WidgetConfig extends BasePluginConfig {
  size?: string;
  colour?: string;
}

class WidgetPlugin extends Plugin {
  static manifest = {
    name: "widget",
    displayName: "Widget",
    version: "0.0.0",
    description: "config-merge probe",
    resources: { required: [], optional: [] },
  } as unknown as PluginManifest;

  static DEFAULT_CONFIG = { size: "medium", colour: "blue" };

  readonly received: WidgetConfig;

  constructor(config: WidgetConfig) {
    super(config);
    this.received = config;
  }
}
// No cast: the class satisfies PluginConstructor, so the factory's config and
// instance types both infer — which is what lets createTestPlugin be typed.
const widget = toPlugin(WidgetPlugin);

describe("createTestPlugin", () => {
  test("returns an instance of the plugin class", () => {
    const plugin = createTestPlugin(widget);
    expect(plugin).toBeInstanceOf(WidgetPlugin);
  });

  test("applies DEFAULT_CONFIG", () => {
    const plugin = createTestPlugin(widget);
    // The hand-rolled `new (widget({}).plugin)({})` skips these entirely.
    expect(plugin.received.size).toBe("medium");
    expect(plugin.received.colour).toBe("blue");
  });

  test("explicit config wins over DEFAULT_CONFIG", () => {
    const plugin = createTestPlugin(widget, {
      size: "large",
    });
    expect(plugin.received.size).toBe("large");
    // Unspecified keys still come from the defaults.
    expect(plugin.received.colour).toBe("blue");
  });

  test("sets the manifest name, which the hand-rolled form forgets", () => {
    const plugin = createTestPlugin(widget);
    expect(plugin.received.name).toBe("widget");
    expect(plugin.name).toBe("widget");
  });

  test("a zero-argument call works", () => {
    expect(() => createTestPlugin(widget)).not.toThrow();
  });

  test("the merge order matches what registration produces", () => {
    // Same order as AppKit.createAndRegisterPlugin: DEFAULT_CONFIG, then the
    // factory's config, then `name`. A caller cannot override `name`, because
    // the manifest owns it.
    const plugin = createTestPlugin(widget, {
      name: "not-this",
      colour: "red",
    });
    expect(plugin.received.name).toBe("widget");
    expect(plugin.received.colour).toBe("red");
  });
});
