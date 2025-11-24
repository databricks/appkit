import type { BasePlugin } from "@databricks-apps/types";
import { setupDatabricksEnv } from "@tools/test-helpers";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { DBX } from "../src/databricks";

// Mock environment validation
vi.mock("@databricks-apps/utils", () => ({
  validateEnv: vi.fn(),
}));

// Test plugin classes for different phases
class CoreTestPlugin implements BasePlugin {
  static DEFAULT_CONFIG = { coreDefault: "core-value" };
  static phase = "core" as const;
  name = "coreTest";
  setupCalled = false;
  validateEnvCalled = false;
  injectedConfig: any;

  constructor(config: any) {
    this.injectedConfig = config;
  }

  validateEnv() {
    this.validateEnvCalled = true;
  }

  async setup() {
    this.setupCalled = true;
  }

  injectRoutes() {}

  asUser() {
    return this;
  }
}

class NormalTestPlugin implements BasePlugin {
  static DEFAULT_CONFIG = { normalDefault: "normal-value" };
  static phase = "normal" as const;
  name = "normalTest";
  setupCalled = false;
  validateEnvCalled = false;
  injectedConfig: any;

  constructor(config: any) {
    this.injectedConfig = config;
  }

  validateEnv() {
    this.validateEnvCalled = true;
  }

  async setup() {
    this.setupCalled = true;
  }

  injectRoutes() {}

  asUser() {
    return this;
  }
}

class DeferredTestPlugin implements BasePlugin {
  static DEFAULT_CONFIG = { deferredDefault: "deferred-value" };
  static phase = "deferred" as const;
  name = "deferredTest";
  setupCalled = false;
  validateEnvCalled = false;
  injectedConfig: any;
  injectedPlugins: any;

  constructor(config: any) {
    this.injectedConfig = config;
    this.injectedPlugins = config.plugins;
  }

  validateEnv() {
    this.validateEnvCalled = true;
  }

  async setup() {
    this.setupCalled = true;
  }

  injectRoutes() {}

  asUser(): any {
    return this;
  }
}

class SlowSetupPlugin implements BasePlugin {
  static DEFAULT_CONFIG = {};
  name = "slowSetup";
  setupDelay: number;
  setupCalled = false;

  constructor(config: any) {
    this.setupDelay = config.setupDelay || 100;
  }

  validateEnv() {}

  async setup() {
    await new Promise((resolve) => setTimeout(resolve, this.setupDelay));
    this.setupCalled = true;
  }

  injectRoutes() {}

  asUser(): any {
    return this;
  }
}

class FailingPlugin implements BasePlugin {
  static DEFAULT_CONFIG = {};
  name = "failing";

  validateEnv() {
    throw new Error("Environment validation failed");
  }

  async setup() {
    throw new Error("Setup failed");
  }

  injectRoutes() {}

  asUser(): any {
    return this;
  }
}

describe("DBX", () => {
  beforeEach(() => {
    setupDatabricksEnv();
    vi.clearAllMocks();
    // Reset singleton instance
    (DBX as any)._instance = null;
  });

  describe("init", () => {
    test("should initialize with empty plugins", async () => {
      const instance = await DBX.init({ plugins: [] });
      expect(instance).toBeDefined();
      expect(instance).toBeInstanceOf(DBX);
    });

    test("should initialize with single plugin", async () => {
      const pluginData = [
        {
          plugin: CoreTestPlugin,
          config: { custom: "value" },
          name: "coreTest",
        },
      ];

      const instance = (await DBX.init({ plugins: pluginData })) as any;

      expect(instance.coreTest).toBeDefined();
      expect(instance.coreTest).toBeInstanceOf(CoreTestPlugin);
      expect(instance.coreTest.setupCalled).toBe(true);
      expect(instance.coreTest.validateEnvCalled).toBe(true);
    });

    test("should merge default and custom plugin configs", async () => {
      const pluginData = [
        {
          plugin: CoreTestPlugin,
          config: { custom: "value" },
          name: "coreTest",
        },
      ];

      const instance = (await DBX.init({ plugins: pluginData })) as any;

      expect(instance.coreTest.injectedConfig).toMatchObject({
        coreDefault: "core-value",
        custom: "value",
        name: "coreTest",
      });
    });

    test("should load plugins in correct phase order", async () => {
      const setupOrder: string[] = [];

      const CoreWithTracking = class extends CoreTestPlugin {
        async setup() {
          setupOrder.push("core");
          await super.setup();
        }
      };

      const NormalWithTracking = class extends NormalTestPlugin {
        async setup() {
          setupOrder.push("normal");
          await super.setup();
        }
      };

      const DeferredWithTracking = class extends DeferredTestPlugin {
        async setup() {
          setupOrder.push("deferred");
          await super.setup();
        }
      };

      const pluginData = [
        { plugin: DeferredWithTracking, config: {}, name: "deferredTest" },
        { plugin: CoreWithTracking, config: {}, name: "coreTest" },
        { plugin: NormalWithTracking, config: {}, name: "normalTest" },
      ];

      await DBX.init({ plugins: pluginData });

      expect(setupOrder).toEqual(["core", "normal", "deferred"]);
    });

    test("should provide plugin instances to deferred plugins", async () => {
      const pluginData = [
        { plugin: CoreTestPlugin, config: {}, name: "coreTest" },
        { plugin: DeferredTestPlugin, config: {}, name: "deferredTest" },
      ];

      const instance = (await DBX.init({ plugins: pluginData })) as any;

      expect(instance.deferredTest.injectedPlugins).toBeDefined();
      expect(instance.deferredTest.injectedPlugins.coreTest).toBe(
        instance.coreTest,
      );
    });

    test("should make plugins accessible as properties", async () => {
      const pluginData = [
        { plugin: CoreTestPlugin, config: {}, name: "coreTest" },
        { plugin: NormalTestPlugin, config: {}, name: "normalTest" },
      ];

      const instance = (await DBX.init({ plugins: pluginData })) as any;

      expect(instance.coreTest).toBeInstanceOf(CoreTestPlugin);
      expect(instance.normalTest).toBeInstanceOf(NormalTestPlugin);

      // Properties should be enumerable
      const keys = Object.keys(instance);
      expect(keys).toContain("coreTest");
      expect(keys).toContain("normalTest");
    });

    test("should handle plugins with slow async setup", async () => {
      const pluginData = [
        { plugin: SlowSetupPlugin, config: { setupDelay: 50 }, name: "slow1" },
        { plugin: SlowSetupPlugin, config: { setupDelay: 100 }, name: "slow2" },
      ];

      const startTime = Date.now();
      const instance = (await DBX.init({ plugins: pluginData })) as any;
      const endTime = Date.now();

      // Should run in parallel, so total time should be closer to max delay (100ms)
      // rather than sum of delays (150ms)
      expect(endTime - startTime).toBeLessThan(140);
      expect(instance.slow1.setupCalled).toBe(true);
      expect(instance.slow2.setupCalled).toBe(true);
    });

    test("should validate environment for all plugins", async () => {
      const pluginData = [
        { plugin: CoreTestPlugin, config: {}, name: "coreTest" },
        { plugin: NormalTestPlugin, config: {}, name: "normalTest" },
      ];

      const instance = (await DBX.init({ plugins: pluginData })) as any;

      expect(instance.coreTest.validateEnvCalled).toBe(true);
      expect(instance.normalTest.validateEnvCalled).toBe(true);
    });

    test("should throw error if plugin environment validation fails", async () => {
      const pluginData = [
        { plugin: FailingPlugin, config: {}, name: "failing" },
      ];

      await expect(DBX.init({ plugins: pluginData })).rejects.toThrow(
        "Environment validation failed",
      );
    });

    test("should throw error if plugin setup fails", async () => {
      const FailingSetupPlugin = class extends FailingPlugin {
        validateEnv() {
          // Don't throw in validateEnv for this test
        }
      };

      const pluginData = [
        { plugin: FailingSetupPlugin, config: {}, name: "failing" },
      ];

      await expect(DBX.init({ plugins: pluginData })).rejects.toThrow(
        "Setup failed",
      );
    });

    test("should handle plugins without phase (default to normal)", async () => {
      class NoPhasePlugin extends NormalTestPlugin {}

      const pluginData = [
        { plugin: NoPhasePlugin, config: {}, name: "noPhase" },
      ];

      const instance = (await DBX.init({ plugins: pluginData })) as any;

      expect(instance.noPhase).toBeInstanceOf(NoPhasePlugin);
    });

    test("should handle plugins with undefined config", async () => {
      const pluginData = [
        { plugin: CoreTestPlugin, config: undefined, name: "coreTest" },
      ];

      const instance = (await DBX.init({ plugins: pluginData })) as any;

      expect(instance.coreTest).toBeInstanceOf(CoreTestPlugin);
      expect(instance.coreTest.injectedConfig.name).toBe("coreTest");
    });

    test("should create singleton instance", async () => {
      const instance1 = await DBX.init({ plugins: [] });
      const instance2 = await DBX.init({ plugins: [] });

      // Should return new instance each time init is called
      expect(instance2).not.toBe(instance1);

      // But internal _instance should be updated
      expect((DBX as any)._instance).toBe(instance2);
    });
  });

  describe("preparePlugins", () => {
    test("should transform plugin data array to plugin map", () => {
      const pluginData = [
        { plugin: CoreTestPlugin, config: { test: "value" }, name: "test1" },
        {
          plugin: NormalTestPlugin,
          config: { another: "config" },
          name: "test2",
        },
      ];

      const result = (DBX as any).preparePlugins(pluginData);

      expect(result).toEqual({
        test1: {
          plugin: CoreTestPlugin,
          config: { test: "value" },
        },
        test2: {
          plugin: NormalTestPlugin,
          config: { another: "config" },
        },
      });
    });

    test("should handle empty plugin array", () => {
      const result = (DBX as any).preparePlugins([]);
      expect(result).toEqual({});
    });
  });

  describe("constructor", () => {
    test("should be private and not directly callable", () => {
      expect(() => new (DBX as any)({})).toThrow();
    });
  });

  describe("plugin registration", () => {
    test("should register plugins with different names", async () => {
      const pluginData = [
        { plugin: CoreTestPlugin, config: {}, name: "plugin1" },
        { plugin: CoreTestPlugin, config: {}, name: "plugin2" },
      ];

      const instance = (await DBX.init({ plugins: pluginData })) as any;

      expect(instance.plugin1).toBeInstanceOf(CoreTestPlugin);
      expect(instance.plugin2).toBeInstanceOf(CoreTestPlugin);
      expect(instance.plugin1).not.toBe(instance.plugin2);
    });

    test("should inject name into plugin config", async () => {
      const pluginData = [
        {
          plugin: CoreTestPlugin,
          config: { custom: "value" },
          name: "testPlugin",
        },
      ];

      const instance = (await DBX.init({ plugins: pluginData })) as any;

      expect(instance.testPlugin.injectedConfig.name).toBe("testPlugin");
    });

    test("should create property getters that return plugin instances", async () => {
      const pluginData = [{ plugin: CoreTestPlugin, config: {}, name: "test" }];

      const instance = (await DBX.init({ plugins: pluginData })) as any;
      const descriptor = Object.getOwnPropertyDescriptor(instance, "test");

      expect(descriptor).toBeDefined();
      expect(descriptor?.get).toBeDefined();
      expect(descriptor?.enumerable).toBe(true);
      expect(descriptor?.get?.call(instance)).toBe(instance.test);
    });
  });

  describe("error handling", () => {
    test("should handle missing plugin data gracefully", async () => {
      const pluginData = [
        { plugin: CoreTestPlugin, config: {}, name: "valid" },
        undefined,
        null,
      ].filter(Boolean) as any;

      const instance = (await DBX.init({ plugins: pluginData })) as any;

      expect(instance.valid).toBeInstanceOf(CoreTestPlugin);
    });

    test("should propagate setup promise rejections", async () => {
      const FailingSetupPlugin = class extends CoreTestPlugin {
        async setup() {
          throw new Error("Async setup failure");
        }
      };

      const pluginData = [
        { plugin: FailingSetupPlugin, config: {}, name: "failing" },
      ];

      await expect(DBX.init({ plugins: pluginData })).rejects.toThrow(
        "Async setup failure",
      );
    });
  });
});
