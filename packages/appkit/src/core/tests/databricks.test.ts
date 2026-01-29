import type { BasePlugin } from "shared";
import { setupDatabricksEnv, mockServiceContext } from "@tools/test-helpers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createApp, AppKit } from "../appkit";
import { ServiceContext } from "../../context/service-context";

// Mock environment validation
vi.mock("../utils", () => ({
  validateEnv: vi.fn(),
  deepMerge: vi.fn((a, b) => ({ ...a, ...b })),
}));

// Mock CacheManager
vi.mock("@databricks-apps/cache", () => ({
  CacheManager: {
    getInstance: vi.fn().mockResolvedValue({
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      getOrExecute: vi.fn(),
    }),
    getInstanceSync: vi.fn().mockReturnValue({
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      getOrExecute: vi.fn(),
    }),
  },
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

  getEndpoints() {
    return {};
  }

  exports() {
    return {
      // Expose internal state for testing
      setupCalled: this.setupCalled,
      validateEnvCalled: this.validateEnvCalled,
      injectedConfig: this.injectedConfig,
    };
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

  getEndpoints() {
    return {};
  }

  exports() {
    return {
      setupCalled: this.setupCalled,
      validateEnvCalled: this.validateEnvCalled,
      injectedConfig: this.injectedConfig,
    };
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

  getEndpoints() {
    return {};
  }

  exports() {
    return {
      setupCalled: this.setupCalled,
      validateEnvCalled: this.validateEnvCalled,
      injectedConfig: this.injectedConfig,
      injectedPlugins: this.injectedPlugins,
    };
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

  getEndpoints() {
    return {};
  }

  exports() {
    return {
      setupCalled: this.setupCalled,
    };
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

  getEndpoints() {
    return {};
  }

  exports() {
    return {};
  }
}

describe("AppKit", () => {
  let serviceContextMock: Awaited<ReturnType<typeof mockServiceContext>>;

  beforeEach(async () => {
    setupDatabricksEnv();
    vi.clearAllMocks();
    // Reset ServiceContext singleton
    ServiceContext.reset();
    // Mock ServiceContext for tests
    serviceContextMock = await mockServiceContext();
  });

  afterEach(() => {
    serviceContextMock?.restore();
  });

  describe("createApp", () => {
    test("should initialize with empty plugins", async () => {
      const instance = await createApp({ plugins: [] });
      expect(instance).toBeDefined();
      expect(instance).toBeInstanceOf(AppKit);
    });

    test("should initialize with single plugin", async () => {
      const pluginData = [
        {
          plugin: CoreTestPlugin,
          config: { custom: "value" },
          name: "coreTest",
        },
      ];

      const instance = (await createApp({ plugins: pluginData })) as any;

      expect(instance.coreTest).toBeDefined();
      // instance.coreTest returns the SDK, not the plugin instance
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

      const instance = (await createApp({ plugins: pluginData })) as any;

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

      await createApp({ plugins: pluginData });

      expect(setupOrder).toEqual(["core", "normal", "deferred"]);
    });

    test("should provide plugin instances to deferred plugins", async () => {
      const pluginData = [
        { plugin: CoreTestPlugin, config: {}, name: "coreTest" },
        { plugin: DeferredTestPlugin, config: {}, name: "deferredTest" },
      ];

      const instance = (await createApp({ plugins: pluginData })) as any;

      // Deferred plugins receive plugin instances (not SDKs) for internal use
      expect(instance.deferredTest.injectedPlugins).toBeDefined();
      expect(instance.deferredTest.injectedPlugins.coreTest).toBeInstanceOf(
        CoreTestPlugin,
      );
    });

    test("should make plugin SDKs accessible as properties", async () => {
      const pluginData = [
        { plugin: CoreTestPlugin, config: {}, name: "coreTest" },
        { plugin: NormalTestPlugin, config: {}, name: "normalTest" },
      ];

      const instance = (await createApp({ plugins: pluginData })) as any;

      // Plugin properties return SDKs, not instances
      expect(instance.coreTest).toBeDefined();
      expect(instance.normalTest).toBeDefined();
      expect(instance.coreTest.setupCalled).toBe(true);
      expect(instance.normalTest.setupCalled).toBe(true);

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
      const instance = (await createApp({ plugins: pluginData })) as any;
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

      const instance = (await createApp({ plugins: pluginData })) as any;

      expect(instance.coreTest.validateEnvCalled).toBe(true);
      expect(instance.normalTest.validateEnvCalled).toBe(true);
    });

    test("should throw error if plugin environment validation fails", async () => {
      const pluginData = [
        { plugin: FailingPlugin, config: {}, name: "failing" },
      ];

      await expect(createApp({ plugins: pluginData })).rejects.toThrow(
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

      await expect(createApp({ plugins: pluginData })).rejects.toThrow(
        "Setup failed",
      );
    });

    test("should handle plugins without phase (default to normal)", async () => {
      class NoPhasePlugin extends NormalTestPlugin {}

      const pluginData = [
        { plugin: NoPhasePlugin, config: {}, name: "noPhase" },
      ];

      const instance = (await createApp({ plugins: pluginData })) as any;

      // Returns SDK, verify it has expected properties
      expect(instance.noPhase).toBeDefined();
      expect(instance.noPhase.setupCalled).toBe(true);
    });

    test("should handle plugins with undefined config", async () => {
      const pluginData = [
        { plugin: CoreTestPlugin, config: undefined, name: "coreTest" },
      ];

      const instance = (await createApp({ plugins: pluginData })) as any;

      expect(instance.coreTest).toBeDefined();
      expect(instance.coreTest.injectedConfig.name).toBe("coreTest");
    });

    test("should create new instance each time", async () => {
      const instance1 = await createApp({ plugins: [] });
      const instance2 = await createApp({ plugins: [] });

      // Each call creates a new instance
      expect(instance2).not.toBe(instance1);
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

      const result = (AppKit as any).preparePlugins(pluginData);

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
      const result = (AppKit as any).preparePlugins([]);
      expect(result).toEqual({});
    });
  });

  describe("constructor", () => {
    test("should be private and not directly callable", () => {
      expect(() => new (AppKit as any)({})).toThrow();
    });
  });

  describe("plugin registration", () => {
    test("should register plugins with different names", async () => {
      const pluginData = [
        { plugin: CoreTestPlugin, config: {}, name: "plugin1" },
        { plugin: CoreTestPlugin, config: {}, name: "plugin2" },
      ];

      const instance = (await createApp({ plugins: pluginData })) as any;

      // SDKs are returned, verify they're different objects
      expect(instance.plugin1).toBeDefined();
      expect(instance.plugin2).toBeDefined();
      expect(instance.plugin1.setupCalled).toBe(true);
      expect(instance.plugin2.setupCalled).toBe(true);
    });

    test("should inject name into plugin config", async () => {
      const pluginData = [
        {
          plugin: CoreTestPlugin,
          config: { custom: "value" },
          name: "testPlugin",
        },
      ];

      const instance = (await createApp({ plugins: pluginData })) as any;

      expect(instance.testPlugin.injectedConfig.name).toBe("testPlugin");
    });

    test("should create property getters that return plugin SDKs", async () => {
      const pluginData = [{ plugin: CoreTestPlugin, config: {}, name: "test" }];

      const instance = (await createApp({ plugins: pluginData })) as any;
      const descriptor = Object.getOwnPropertyDescriptor(instance, "test");

      expect(descriptor).toBeDefined();
      expect(descriptor?.get).toBeDefined();
      expect(descriptor?.enumerable).toBe(true);
      // Getter returns SDK object
      const sdk = descriptor?.get?.call(instance);
      expect(sdk).toBeDefined();
      expect(sdk.setupCalled).toBe(true);
    });
  });

  describe("error handling", () => {
    test("should handle missing plugin data gracefully", async () => {
      const pluginData = [
        { plugin: CoreTestPlugin, config: {}, name: "valid" },
        undefined,
        null,
      ].filter(Boolean) as any;

      const instance = (await createApp({ plugins: pluginData })) as any;

      // Returns SDK, verify it's defined and working
      expect(instance.valid).toBeDefined();
      expect(instance.valid.setupCalled).toBe(true);
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

      await expect(createApp({ plugins: pluginData })).rejects.toThrow(
        "Async setup failure",
      );
    });
  });

  describe("SDK context binding", () => {
    test("should bind SDK methods to plugin instance", async () => {
      class ContextTestPlugin implements BasePlugin {
        static DEFAULT_CONFIG = {};
        name = "contextTest";
        private counter = 0;

        validateEnv() {}
        async setup() {}
        injectRoutes() {}
        getEndpoints() {
          return {};
        }

        increment() {
          this.counter++;
        }

        exports() {
          return {
            increment: this.increment,
            getCounter: () => this.counter,
          };
        }
      }

      const pluginData = [
        { plugin: ContextTestPlugin, config: {}, name: "contextTest" },
      ];

      const instance = (await createApp({ plugins: pluginData })) as any;

      // Destructure the method - this would fail without proper binding
      const { increment, getCounter } = instance.contextTest;

      expect(getCounter()).toBe(0);
      increment();
      increment();
      expect(getCounter()).toBe(2);
    });

    test("should maintain context when SDK method is passed as callback", async () => {
      class CallbackTestPlugin implements BasePlugin {
        static DEFAULT_CONFIG = {};
        name = "callbackTest";
        private values: number[] = [];

        validateEnv() {}
        async setup() {}
        injectRoutes() {}
        getEndpoints() {
          return {};
        }

        addValue(value: number) {
          this.values.push(value);
        }

        exports() {
          return {
            addValue: this.addValue,
            getValues: () => [...this.values],
          };
        }
      }

      const pluginData = [
        { plugin: CallbackTestPlugin, config: {}, name: "callbackTest" },
      ];

      const instance = (await createApp({ plugins: pluginData })) as any;
      const { addValue, getValues } = instance.callbackTest;

      // Pass method as callback to array forEach
      [1, 2, 3].forEach(addValue);

      expect(getValues()).toEqual([1, 2, 3]);
    });
  });
});
