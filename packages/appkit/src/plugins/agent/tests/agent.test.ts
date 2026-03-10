import {
  createMockRouter,
  mockServiceContext,
  setupDatabricksEnv,
} from "@tools/test-helpers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ServiceContext } from "../../../context/service-context";
import { AgentPlugin, agent } from "../agent";
import type { IAgentConfig } from "../types";
import { StubAgent } from "./stub-agent";

// Mock CacheManager singleton
vi.mock("../../../cache", () => ({
  CacheManager: {
    getInstanceSync: vi.fn(() => ({
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      getOrExecute: vi.fn(async (_key: unknown[], fn: () => Promise<unknown>) =>
        fn(),
      ),
      generateKey: vi.fn(() => "test-key"),
    })),
  },
}));

describe("AgentPlugin", () => {
  let serviceContextMock: Awaited<ReturnType<typeof mockServiceContext>>;

  beforeEach(async () => {
    setupDatabricksEnv();
    ServiceContext.reset();
    serviceContextMock = await mockServiceContext();
  });

  afterEach(() => {
    serviceContextMock?.restore();
  });

  test("agent factory produces correct plugin data", () => {
    const pluginData = agent({ agentInstance: new StubAgent() });
    expect(pluginData.name).toBe("agent");
  });

  test("plugin has correct manifest", () => {
    expect(AgentPlugin.manifest).toBeDefined();
    expect(AgentPlugin.manifest.name).toBe("agent");
    expect(AgentPlugin.manifest.resources.required).toHaveLength(1);
    expect(AgentPlugin.manifest.resources.required[0].type).toBe(
      "serving_endpoint",
    );
  });

  test("plugin instance has correct name", () => {
    const config: IAgentConfig = { agentInstance: new StubAgent() };
    const plugin = new AgentPlugin(config);
    expect(plugin.name).toBe("agent");
  });

  describe("setup()", () => {
    test("uses provided agentInstance", async () => {
      const stub = new StubAgent();
      const config: IAgentConfig = { agentInstance: stub };
      const plugin = new AgentPlugin(config);

      await plugin.setup();

      const exported = plugin.exports();
      const result = await exported.invoke([{ role: "user", content: "hi" }]);
      expect(result).toContain("Echo: hi");
    });

    test("throws when no model and no agentInstance", async () => {
      const config: IAgentConfig = {};
      const plugin = new AgentPlugin(config);

      await expect(plugin.setup()).rejects.toThrow("model name is required");
    });

    test("resolves model from env var when not in config", async () => {
      process.env.DATABRICKS_MODEL = "test-model";

      const config: IAgentConfig = {};
      const plugin = new AgentPlugin(config);

      // Will fail because ChatDatabricks isn't available, but it
      // should get past the model name check
      try {
        await plugin.setup();
      } catch (e: any) {
        expect(e.message).not.toContain("model name is required");
      }

      delete process.env.DATABRICKS_MODEL;
    });
  });

  describe("injectRoutes()", () => {
    test("registers POST handler on router", () => {
      const stub = new StubAgent();
      const config: IAgentConfig = { agentInstance: stub };
      const plugin = new AgentPlugin(config);

      const { router } = createMockRouter();
      plugin.injectRoutes(router as any);

      expect(router.post).toHaveBeenCalledWith("/", expect.any(Function));
    });
  });

  describe("exports()", () => {
    test("returns invoke and stream methods", async () => {
      const stub = new StubAgent();
      const config: IAgentConfig = { agentInstance: stub };
      const plugin = new AgentPlugin(config);
      await plugin.setup();

      const exported = plugin.exports();

      expect(typeof exported.invoke).toBe("function");
      expect(typeof exported.stream).toBe("function");
    });

    test("invoke returns text from agent response", async () => {
      const stub = new StubAgent();
      const config: IAgentConfig = { agentInstance: stub };
      const plugin = new AgentPlugin(config);
      await plugin.setup();

      const result = await plugin
        .exports()
        .invoke([{ role: "user", content: "test message" }]);

      expect(result).toBe("Echo: test message");
    });

    test("stream yields ResponseStreamEvents", async () => {
      const stub = new StubAgent();
      const config: IAgentConfig = { agentInstance: stub };
      const plugin = new AgentPlugin(config);
      await plugin.setup();

      const events: any[] = [];
      for await (const event of plugin
        .exports()
        .stream([{ role: "user", content: "hello" }])) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);
      const deltaEvent = events.find(
        (e) => e.type === "response.output_text.delta",
      );
      expect(deltaEvent).toBeDefined();
      expect(deltaEvent.delta).toContain("Echo: hello");

      const completedEvent = events.find(
        (e) => e.type === "response.completed",
      );
      expect(completedEvent).toBeDefined();
    });

    test("throws when not initialized", async () => {
      const config: IAgentConfig = { agentInstance: new StubAgent() };
      const plugin = new AgentPlugin(config);

      await expect(
        plugin.exports().invoke([{ role: "user", content: "hi" }]),
      ).rejects.toThrow("not initialized");
    });
  });
});
