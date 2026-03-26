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

// Mock server plugin to avoid actually starting a server
vi.mock("../../plugins/server", () => {
  const manifest = {
    name: "server",
    displayName: "Server",
    description: "Server",
    resources: { required: [], optional: [] },
  };

  class MockServerPlugin {
    static manifest = manifest;
    static phase = "deferred";
    static DEFAULT_CONFIG = {};
    name = "server";
    config: any;
    constructor(config: any) {
      this.config = config;
    }
    async setup() {}
    injectRoutes() {}
    getEndpoints() {
      return {};
    }
    exports() {
      return {
        start: vi.fn(),
        extend: vi.fn(),
        getServer: vi.fn(),
        getConfig: vi.fn(() => this.config),
      };
    }
  }

  return {
    server: (config: any = {}) => ({
      plugin: MockServerPlugin,
      config,
      name: "server",
    }),
    ServerPlugin: MockServerPlugin,
  };
});

import type { AgentAdapter, AgentEvent } from "shared";
import { createAgent } from "../create-agent";

function createMockAdapter(): AgentAdapter {
  return {
    async *run(): AsyncGenerator<AgentEvent> {
      yield { type: "message_delta", content: "hello" };
    },
  };
}

describe("createAgent", () => {
  test("returns an AgentHandle with registerAgent, getTools, getThreads", async () => {
    const handle = await createAgent({
      adapter: createMockAdapter(),
    });

    expect(handle.registerAgent).toBeTypeOf("function");
    expect(handle.getTools).toBeTypeOf("function");
    expect(handle.getThreads).toBeTypeOf("function");
    expect(handle.plugins).toBeDefined();
  });

  test("adapter shorthand registers as 'assistant'", async () => {
    const handle = await createAgent({
      adapter: createMockAdapter(),
    });

    const tools = handle.getTools();
    expect(tools).toBeInstanceOf(Array);
  });

  test("agents record is passed through", async () => {
    const handle = await createAgent({
      agents: {
        main: createMockAdapter(),
        secondary: createMockAdapter(),
      },
      defaultAgent: "main",
    });

    expect(handle.getTools).toBeTypeOf("function");
  });

  test("throws when both adapter and agents are provided", async () => {
    await expect(
      createAgent({
        adapter: createMockAdapter(),
        agents: { other: createMockAdapter() },
      }),
    ).rejects.toThrow("mutually exclusive");
  });

  test("plugins namespace excludes agent and server", async () => {
    const handle = await createAgent({
      adapter: createMockAdapter(),
    });

    expect(handle.plugins).not.toHaveProperty("agent");
    expect(handle.plugins).not.toHaveProperty("server");
  });

  test("accepts port and host config", async () => {
    const handle = await createAgent({
      adapter: createMockAdapter(),
      port: 9000,
      host: "127.0.0.1",
    });

    expect(handle).toBeDefined();
  });

  test("works with promised adapters", async () => {
    const handle = await createAgent({
      adapter: Promise.resolve(createMockAdapter()),
    });

    expect(handle.registerAgent).toBeTypeOf("function");
  });

  test("registerAgent allows adding agents after creation", async () => {
    const handle = await createAgent({
      adapter: createMockAdapter(),
    });

    handle.registerAgent("second", createMockAdapter());
    expect(handle.getTools).toBeTypeOf("function");
  });
});
