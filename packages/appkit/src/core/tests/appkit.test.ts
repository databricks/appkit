import type { AgentToolDefinition, ToolProvider } from "shared";
import { describe, expect, test, vi } from "vitest";

vi.mock("../../cache", () => ({
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

vi.mock("../../telemetry", () => ({
  TelemetryManager: {
    initialize: vi.fn(),
    getProvider: vi.fn(() => ({
      getTracer: vi.fn(),
      getMeter: vi.fn(),
      getLogger: vi.fn(),
      emit: vi.fn(),
      startActiveSpan: vi.fn(),
      registerInstrumentations: vi.fn(),
    })),
  },
  normalizeTelemetryOptions: vi.fn(() => ({
    traces: false,
    metrics: false,
    logs: false,
  })),
}));

vi.mock("../../context/service-context", () => {
  const mockClient = {
    statementExecution: { executeStatement: vi.fn() },
    currentUser: { me: vi.fn().mockResolvedValue({ id: "test-user" }) },
    config: { host: "https://test.databricks.com" },
  };

  return {
    ServiceContext: {
      initialize: vi.fn().mockResolvedValue({
        client: mockClient,
        serviceUserId: "test-service-user",
        workspaceId: Promise.resolve("test-workspace"),
      }),
      get: vi.fn().mockReturnValue({
        client: mockClient,
        serviceUserId: "test-service-user",
        workspaceId: Promise.resolve("test-workspace"),
      }),
      isInitialized: vi.fn().mockReturnValue(true),
      createUserContext: vi.fn(),
    },
  };
});

vi.mock("../../registry", () => ({
  ResourceRegistry: vi.fn().mockImplementation(() => ({
    collectResources: vi.fn(),
    getRequired: vi.fn().mockReturnValue([]),
    enforceValidation: vi.fn(),
  })),
  ResourceType: { SQL_WAREHOUSE: "sql_warehouse" },
  getPluginManifest: vi.fn(),
  getResourceRequirements: vi.fn(),
}));

import { toPlugin, toPluginWithInstance } from "../../plugin/to-plugin";
import { createApp } from "../appkit";

const manifest = {
  name: "counter",
  displayName: "Counter",
  description: "Counter",
  resources: { required: [], optional: [] },
};

function makeCounterPlugin() {
  let constructions = 0;
  class CounterPlugin implements ToolProvider {
    static manifest = manifest;
    static DEFAULT_CONFIG = {};
    name = "counter";
    id: number;
    flag = false;
    constructor(public config: unknown) {
      constructions += 1;
      this.id = constructions;
    }
    async setup() {}
    injectRoutes() {}
    getEndpoints() {
      return {};
    }
    getAgentTools(): AgentToolDefinition[] {
      return [];
    }
    async executeAgentTool() {
      return "ok";
    }
    exports() {
      return {
        getFlag: () => this.flag,
        getId: () => this.id,
      };
    }
  }
  return {
    CounterPlugin,
    getConstructionCount: () => constructions,
  };
}

describe("AppKit.preparePlugins instance forwarding", () => {
  test("toPluginWithInstance: reuses the eagerly constructed instance", async () => {
    const { CounterPlugin, getConstructionCount } = makeCounterPlugin();

    const counter = toPluginWithInstance(
      CounterPlugin as never,
      ["exports"] as const,
    );
    const pluginData = counter();

    expect(getConstructionCount()).toBe(1);
    expect(pluginData.instance).toBeDefined();

    (pluginData.instance as unknown as { flag: boolean }).flag = true;
    const factoryId = (pluginData.instance as unknown as { id: number }).id;

    const app = await createApp({ plugins: [pluginData] });

    expect(getConstructionCount()).toBe(1);

    const handle = (
      app as unknown as Record<
        string,
        { getFlag: () => boolean; getId: () => number }
      >
    ).counter;
    expect(handle.getFlag()).toBe(true);
    expect(handle.getId()).toBe(factoryId);
  });

  test("toPlugin: constructs a fresh instance inside createApp (unchanged behavior)", async () => {
    const { CounterPlugin, getConstructionCount } = makeCounterPlugin();

    const counter = toPlugin(CounterPlugin as never);
    const pluginData = counter();

    expect(getConstructionCount()).toBe(0);
    expect((pluginData as { instance?: unknown }).instance).toBeUndefined();

    const app = await createApp({ plugins: [pluginData] });

    expect(getConstructionCount()).toBe(1);

    const handle = (
      app as unknown as Record<
        string,
        { getFlag: () => boolean; getId: () => number }
      >
    ).counter;
    expect(handle.getFlag()).toBe(false);
    expect(handle.getId()).toBe(1);
  });
});
