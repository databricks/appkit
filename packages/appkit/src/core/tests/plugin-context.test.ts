import type { AgentToolDefinition } from "shared";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { isToolProvider, PluginContext } from "../plugin-context";

/**
 * Holds the most recent mock span instance so tests can assert against
 * `setStatus` / `recordException` / `end` calls without relying on global
 * spies. The PluginContext mock below repopulates this on every
 * `startActiveSpan` call.
 */
const lastSpan: {
  setStatus: ReturnType<typeof vi.fn>;
  recordException: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} = {
  setStatus: vi.fn(),
  recordException: vi.fn(),
  end: vi.fn(),
};

vi.mock("../../telemetry", async () => {
  const actual =
    await vi.importActual<typeof import("../../telemetry")>("../../telemetry");
  return {
    ...actual,
    TelemetryManager: {
      getProvider: () => ({
        getTracer: () => ({
          startActiveSpan: (_name: string, fn: (span: unknown) => unknown) => {
            lastSpan.setStatus = vi.fn();
            lastSpan.recordException = vi.fn();
            lastSpan.end = vi.fn();
            return fn(lastSpan);
          },
        }),
      }),
    },
  };
});

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

    test("duplicate registerToolProvider name overwrites and exposes only the latest", () => {
      const first = createMockToolProvider();
      const second = createMockToolProvider();

      ctx.registerToolProvider("analytics", first);
      ctx.registerToolProvider("analytics", second);

      const providers = ctx.getToolProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0].provider).toBe(second);
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

    test("marks the span OK on success and ends it", async () => {
      const { SpanStatusCode } = await import("../../telemetry");
      const provider = createMockToolProvider();
      ctx.registerToolProvider("analytics", provider);

      await ctx.executeTool({ headers: {} } as any, "analytics", "query", {});

      expect(lastSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.OK,
      });
      expect(lastSpan.recordException).not.toHaveBeenCalled();
      expect(lastSpan.end).toHaveBeenCalledTimes(1);
    });

    test("marks the span ERROR with message on failure and records the exception", async () => {
      const { SpanStatusCode } = await import("../../telemetry");
      const provider = createMockToolProvider();
      const failure = new Error("Query failed");
      (provider.executeAgentTool as any).mockRejectedValue(failure);
      ctx.registerToolProvider("analytics", provider);

      await expect(
        ctx.executeTool({ headers: {} } as any, "analytics", "query", {}),
      ).rejects.toThrow("Query failed");

      expect(lastSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: "Query failed",
      });
      expect(lastSpan.recordException).toHaveBeenCalledWith(failure);
      expect(lastSpan.end).toHaveBeenCalledTimes(1);
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

    test("aborts the call once `timeoutMs` elapses", async () => {
      // Defaults previously hardcoded 30s in PluginContext, which truncated
      // legitimate cold-warehouse SQL queries. The default is now 5 minutes
      // and per-call configurable; assert the configured value actually
      // drives the AbortSignal so the timeout knob has bite.
      vi.useFakeTimers();
      try {
        const provider = createMockToolProvider();
        // Resolve only when the inbound signal aborts, so the test can
        // observe the timeout firing.
        (provider.executeAgentTool as any).mockImplementation(
          (_name: string, _args: unknown, signal: AbortSignal | undefined) =>
            new Promise((_, reject) => {
              signal?.addEventListener("abort", () =>
                reject(new Error("Aborted")),
              );
            }),
        );
        ctx.registerToolProvider("analytics", provider);

        const pending = ctx.executeTool(
          { headers: {} } as any,
          "analytics",
          "query",
          {},
          undefined,
          50,
        );
        await vi.advanceTimersByTimeAsync(60);
        await expect(pending).rejects.toThrow();
      } finally {
        vi.useRealTimers();
      }
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

    test("a callback that registers another hook for the same event does not re-enter the loop", async () => {
      // Snapshot semantics: late-added hooks must not be visited by the
      // current emit pass, otherwise ECMAScript Set iteration would re-enter
      // and a self-registering hook would loop indefinitely.
      const recorded: string[] = [];
      const second = vi.fn(() => {
        recorded.push("second");
      });
      const first = vi.fn(() => {
        recorded.push("first");
        ctx.onLifecycle("setup:complete", second);
      });
      ctx.onLifecycle("setup:complete", first);

      await ctx.emitLifecycle("setup:complete");

      expect(recorded).toEqual(["first"]);
      expect(second).not.toHaveBeenCalled();
    });
  });

  describe("registerAsRouteTarget", () => {
    test("ignores duplicate registration and warns", () => {
      const first = { addExtension: vi.fn() };
      const second = { addExtension: vi.fn() };

      ctx.registerAsRouteTarget(first);
      ctx.registerAsRouteTarget(second);

      const handler = vi.fn();
      ctx.addRoute("get", "/late", handler);

      // The late route must reach the first target only.
      expect(first.addExtension).toHaveBeenCalledTimes(1);
      expect(second.addExtension).not.toHaveBeenCalled();
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

  test("returns false for objects missing asUser", () => {
    // ToolProvider plugins must also expose user-scoped execution; the
    // guard ensures executeTool can call asUser without an unsafe cast.
    expect(
      isToolProvider({
        getAgentTools: vi.fn(),
        executeAgentTool: vi.fn(),
      }),
    ).toBe(false);
  });
});
