import type { AgentToolDefinition } from "shared";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { isToolProvider, PluginContext } from "../plugin-context";

vi.mock("../../telemetry", () => ({
  TelemetryManager: {
    getProvider: () => ({
      getTracer: () => ({
        startActiveSpan: (_name: string, fn: (span: any) => any) => {
          const span = {
            setStatus: vi.fn(),
            recordException: vi.fn(),
            end: vi.fn(),
          };
          return fn(span);
        },
      }),
    }),
  },
}));

vi.mock("../../logging/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function createMockToolProvider(tools: AgentToolDefinition[] = []) {
  const mock = {
    name: "mock-plugin",
    setup: vi.fn().mockResolvedValue(undefined),
    injectRoutes: vi.fn(),
    getEndpoints: vi.fn().mockReturnValue({}),
    getAgentTools: vi.fn().mockReturnValue(tools),
    executeAgentTool: vi.fn().mockResolvedValue("tool-result"),
    asUser: vi.fn().mockReturnThis(),
  };
  return mock as any;
}

describe("PluginContext", () => {
  let ctx: PluginContext;

  beforeEach(() => {
    ctx = new PluginContext();
  });

  describe("route buffering", () => {
    test("addRoute buffers when no route target exists", () => {
      const handler = vi.fn();
      ctx.addRoute("post", "/invocations", handler);

      expect(ctx.getPluginNames()).toEqual([]);
    });

    test("flushRoutes applies buffered routes via addExtension", () => {
      const handler = vi.fn();
      ctx.addRoute("post", "/invocations", handler);

      const addExtension = vi.fn();
      ctx.registerAsRouteTarget({ addExtension });

      expect(addExtension).toHaveBeenCalledTimes(1);
      const extensionFn = addExtension.mock.calls[0][0];

      const mockApp = { post: vi.fn() };
      extensionFn(mockApp);
      expect(mockApp.post).toHaveBeenCalledWith("/invocations", handler);
    });

    test("addRoute called after registerAsRouteTarget applies immediately", () => {
      const addExtension = vi.fn();
      ctx.registerAsRouteTarget({ addExtension });

      const handler = vi.fn();
      ctx.addRoute("get", "/health", handler);

      expect(addExtension).toHaveBeenCalledTimes(1);
      const extensionFn = addExtension.mock.calls[0][0];

      const mockApp = { get: vi.fn() };
      extensionFn(mockApp);
      expect(mockApp.get).toHaveBeenCalledWith("/health", handler);
    });

    test("addRoute supports middleware chains", () => {
      const auth = vi.fn();
      const handler = vi.fn();

      const addExtension = vi.fn();
      ctx.registerAsRouteTarget({ addExtension });

      ctx.addRoute("post", "/api", auth, handler);

      const extensionFn = addExtension.mock.calls[0][0];
      const mockApp = { post: vi.fn() };
      extensionFn(mockApp);
      expect(mockApp.post).toHaveBeenCalledWith("/api", auth, handler);
    });

    test("addMiddleware buffers and applies via use()", () => {
      const handler = vi.fn();
      ctx.addMiddleware("/api", handler);

      const addExtension = vi.fn();
      ctx.registerAsRouteTarget({ addExtension });

      expect(addExtension).toHaveBeenCalledTimes(1);
      const extensionFn = addExtension.mock.calls[0][0];

      const mockApp = { use: vi.fn() };
      extensionFn(mockApp);
      expect(mockApp.use).toHaveBeenCalledWith("/api", handler);
    });

    test("multiple buffered routes are all applied on registration", () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      ctx.addRoute("post", "/a", h1);
      ctx.addRoute("get", "/b", h2);

      const addExtension = vi.fn();
      ctx.registerAsRouteTarget({ addExtension });

      expect(addExtension).toHaveBeenCalledTimes(2);
    });
  });

  describe("ToolProvider registry", () => {
    test("registerToolProvider makes provider visible via getToolProviders", () => {
      const provider = createMockToolProvider([
        {
          name: "query",
          description: "Run query",
          parameters: { type: "object" },
        },
      ]);

      ctx.registerToolProvider("analytics", provider);

      const providers = ctx.getToolProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0].name).toBe("analytics");
      expect(providers[0].provider.getAgentTools()).toHaveLength(1);
    });

    test("getToolProviders returns all registered providers", () => {
      ctx.registerToolProvider("analytics", createMockToolProvider());
      ctx.registerToolProvider("files", createMockToolProvider());
      ctx.registerToolProvider("genie", createMockToolProvider());

      expect(ctx.getToolProviders()).toHaveLength(3);
    });

    test("getToolProviders returns current set, not snapshot", () => {
      const before = ctx.getToolProviders();
      expect(before).toHaveLength(0);

      ctx.registerToolProvider("analytics", createMockToolProvider());

      const after = ctx.getToolProviders();
      expect(after).toHaveLength(1);
    });
  });

  describe("executeTool", () => {
    test("calls asUser(req).executeAgentTool on the correct plugin", async () => {
      const provider = createMockToolProvider();
      ctx.registerToolProvider("analytics", provider);

      const mockReq = { headers: {} } as any;
      await ctx.executeTool(mockReq, "analytics", "query", { sql: "SELECT 1" });

      expect(provider.asUser).toHaveBeenCalledWith(mockReq);
      expect(provider.executeAgentTool).toHaveBeenCalledWith(
        "query",
        { sql: "SELECT 1" },
        expect.any(Object),
      );
    });

    test("throws for unknown plugin name", async () => {
      const mockReq = { headers: {} } as any;

      await expect(
        ctx.executeTool(mockReq, "nonexistent", "query", {}),
      ).rejects.toThrow('unknown plugin "nonexistent"');
    });

    test("propagates tool execution errors", async () => {
      const provider = createMockToolProvider();
      (provider.executeAgentTool as any).mockRejectedValue(
        new Error("Query failed"),
      );
      ctx.registerToolProvider("analytics", provider);

      const mockReq = { headers: {} } as any;

      await expect(
        ctx.executeTool(mockReq, "analytics", "query", {}),
      ).rejects.toThrow("Query failed");
    });

    test("passes abort signal to executeAgentTool", async () => {
      const provider = createMockToolProvider();
      ctx.registerToolProvider("analytics", provider);

      const controller = new AbortController();
      const mockReq = { headers: {} } as any;

      await ctx.executeTool(
        mockReq,
        "analytics",
        "query",
        {},
        controller.signal,
      );

      const callArgs = (provider.executeAgentTool as any).mock.calls[0];
      expect(callArgs[2]).toBeDefined();
    });
  });

  describe("lifecycle hooks", () => {
    test("onLifecycle registers callback, emitLifecycle invokes it", async () => {
      const fn = vi.fn();
      ctx.onLifecycle("setup:complete", fn);

      await ctx.emitLifecycle("setup:complete");

      expect(fn).toHaveBeenCalledTimes(1);
    });

    test("multiple callbacks for the same event all fire", async () => {
      const fn1 = vi.fn();
      const fn2 = vi.fn();
      ctx.onLifecycle("setup:complete", fn1);
      ctx.onLifecycle("setup:complete", fn2);

      await ctx.emitLifecycle("setup:complete");

      expect(fn1).toHaveBeenCalledTimes(1);
      expect(fn2).toHaveBeenCalledTimes(1);
    });

    test("callback error does not prevent other callbacks from running", async () => {
      const fn1 = vi.fn().mockRejectedValue(new Error("fail"));
      const fn2 = vi.fn();
      ctx.onLifecycle("shutdown", fn1);
      ctx.onLifecycle("shutdown", fn2);

      await ctx.emitLifecycle("shutdown");

      expect(fn1).toHaveBeenCalled();
      expect(fn2).toHaveBeenCalled();
    });

    test("emitLifecycle with no registered hooks does nothing", async () => {
      await expect(ctx.emitLifecycle("server:ready")).resolves.toBeUndefined();
    });
  });

  describe("plugin metadata", () => {
    const stubPlugin = { name: "stub" } as any;

    test("getPluginNames returns all registered names", () => {
      ctx.registerPlugin("analytics", stubPlugin);
      ctx.registerPlugin("server", stubPlugin);
      ctx.registerPlugin("agent", stubPlugin);

      const names = ctx.getPluginNames();
      expect(names).toContain("analytics");
      expect(names).toContain("server");
      expect(names).toContain("agent");
      expect(names).toHaveLength(3);
    });

    test("hasPlugin returns true for registered plugins", () => {
      ctx.registerPlugin("analytics", stubPlugin);

      expect(ctx.hasPlugin("analytics")).toBe(true);
      expect(ctx.hasPlugin("nonexistent")).toBe(false);
    });

    test("getPlugins returns all registered instances", () => {
      const p1 = { name: "analytics" } as any;
      const p2 = { name: "server" } as any;
      ctx.registerPlugin("analytics", p1);
      ctx.registerPlugin("server", p2);

      const plugins = ctx.getPlugins();
      expect(plugins.size).toBe(2);
      expect(plugins.get("analytics")).toBe(p1);
      expect(plugins.get("server")).toBe(p2);
    });
  });
});

describe("isToolProvider", () => {
  test("returns true for objects with getAgentTools and executeAgentTool", () => {
    const provider = createMockToolProvider();
    expect(isToolProvider(provider)).toBe(true);
  });

  test("returns false for null", () => {
    expect(isToolProvider(null)).toBe(false);
  });

  test("returns false for objects missing executeAgentTool", () => {
    expect(isToolProvider({ getAgentTools: vi.fn() })).toBe(false);
  });

  test("returns false for objects missing getAgentTools", () => {
    expect(isToolProvider({ executeAgentTool: vi.fn() })).toBe(false);
  });

  test("returns false for non-objects", () => {
    expect(isToolProvider("string")).toBe(false);
    expect(isToolProvider(42)).toBe(false);
    expect(isToolProvider(undefined)).toBe(false);
  });
});
