import {
  createMockRequest,
  createMockResponse,
  createMockRouter,
  setupDatabricksEnv,
} from "@tools/test-helpers";
import type {
  AgentAdapter,
  AgentEvent,
  AgentInput,
  AgentRunContext,
  AgentToolDefinition,
  ToolProvider,
} from "shared";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AgentPlugin } from "../agent";

vi.mock("../../../cache", () => ({
  CacheManager: {
    getInstanceSync: vi.fn(() => ({
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      getOrExecute: vi.fn(),
      generateKey: vi.fn(),
    })),
  },
}));

vi.mock("../../../context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../context")>();
  return {
    ...actual,
    getCurrentUserId: vi.fn(() => "test-user"),
    getExecutionContext: vi.fn(() => ({
      userId: "test-user",
      isUserContext: false,
    })),
  };
});

vi.mock("../../../telemetry", () => ({
  TelemetryManager: {
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

function createMockToolProvider(
  tools: AgentToolDefinition[],
): ToolProvider & { asUser: any } {
  return {
    getAgentTools: () => tools,
    executeAgentTool: vi.fn().mockResolvedValue({ result: "ok" }),
    asUser: vi.fn().mockReturnThis(),
  };
}

async function* mockAdapterRun(): AsyncGenerator<AgentEvent> {
  yield { type: "message_delta", content: "Hello " };
  yield { type: "message_delta", content: "world" };
}

function createMockAdapter(): AgentAdapter {
  return {
    run: vi.fn().mockReturnValue(mockAdapterRun()),
  };
}

describe("AgentPlugin", () => {
  beforeEach(() => {
    setupDatabricksEnv();
  });

  test("collectTools discovers ToolProvider plugins", async () => {
    const mockProvider = createMockToolProvider([
      {
        name: "query",
        description: "Run a query",
        parameters: { type: "object", properties: {} },
      },
    ]);

    const plugin = new AgentPlugin({
      name: "agent",
      plugins: { analytics: mockProvider },
    });

    await plugin.setup();

    const exports = plugin.exports();
    const tools = exports.getTools();

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("analytics.query");
  });

  test("skips non-ToolProvider plugins", async () => {
    const plugin = new AgentPlugin({
      name: "agent",
      plugins: {
        server: { name: "server" },
        analytics: createMockToolProvider([
          { name: "query", description: "q", parameters: { type: "object" } },
        ]),
      },
    });

    await plugin.setup();
    const tools = plugin.exports().getTools();
    expect(tools).toHaveLength(1);
  });

  test("registerAgent and resolveAgent", () => {
    const plugin = new AgentPlugin({ name: "agent" });
    const adapter = createMockAdapter();

    plugin.exports().registerAgent("assistant", adapter);

    // The first registered agent becomes the default
    const tools = plugin.exports().getTools();
    expect(tools).toEqual([]);
  });

  test("injectRoutes registers chat, cancel, and thread routes", () => {
    const plugin = new AgentPlugin({ name: "agent" });
    const { router, handlers } = createMockRouter();

    plugin.injectRoutes(router);

    expect(handlers["POST:/chat"]).toBeDefined();
    expect(handlers["POST:/cancel"]).toBeDefined();
    expect(handlers["GET:/threads"]).toBeDefined();
    expect(handlers["GET:/threads/:threadId"]).toBeDefined();
    expect(handlers["DELETE:/threads/:threadId"]).toBeDefined();
  });

  test("clientConfig exposes tools and agents", async () => {
    const plugin = new AgentPlugin({
      name: "agent",
      agents: { assistant: createMockAdapter() },
    });
    await plugin.setup();

    const config = plugin.clientConfig();
    expect(config.tools).toEqual([]);
    expect(config.agents).toEqual(["assistant"]);
    expect(config.defaultAgent).toBe("assistant");
  });

  test("exports().addTools adds function tools", () => {
    const plugin = new AgentPlugin({ name: "agent" });

    plugin.exports().addTools([
      {
        type: "function" as const,
        name: "myTool",
        description: "A custom tool",
        parameters: { type: "object", properties: {} },
        execute: async () => "result",
      },
    ]);

    const tools = plugin.exports().getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("myTool");
  });

  test("executeTool always calls asUser(req) for plugin tools, even without requiresUserContext", async () => {
    const mockProvider = createMockToolProvider([
      {
        name: "action",
        description: "An action without requiresUserContext",
        parameters: { type: "object", properties: {} },
      },
    ]);

    function createToolCallingAdapter(): AgentAdapter {
      return {
        async *run(
          _input: AgentInput,
          context: AgentRunContext,
        ): AsyncGenerator<AgentEvent> {
          await context.executeTool("testplugin.action", {});
          yield { type: "message_delta", content: "done" };
        },
      };
    }

    const plugin = new AgentPlugin({
      name: "agent",
      agents: { assistant: createToolCallingAdapter() },
      plugins: { testplugin: mockProvider },
    });
    await plugin.setup();

    const { router, getHandler } = createMockRouter();
    plugin.injectRoutes(router);
    const handler = getHandler("POST", "/chat");

    const req = createMockRequest({
      body: { message: "hi" },
      headers: {
        "x-forwarded-user": "test-user",
        "x-forwarded-access-token": "test-token",
      },
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(mockProvider.asUser).toHaveBeenCalledWith(req);
    expect(mockProvider.executeAgentTool).toHaveBeenCalledWith(
      "action",
      {},
      expect.anything(),
    );
  });
});
